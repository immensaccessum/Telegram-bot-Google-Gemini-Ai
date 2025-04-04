import { Telegraf } from 'telegraf';
import { GoogleGenerativeAI, HarmBlockThreshold, HarmCategory } from "@google/generative-ai";
import fetch from 'node-fetch';
import dotenv from 'dotenv';
dotenv.config();

// --- Constants ---

// Define the available models. Keys are the command names (without '/'), values are the actual Model IDs for the API.
// WARNING: Ensure these Model IDs are valid and accessible with your API Key.
// Using the exact names provided, but some might be experimental or non-existent.
const ALLOWED_MODELS = {
    // Command Key             ->  Model ID for Google API
    "gemini15flash":         "gemini-1.5-flash",         // Stable Flash model
    "gemini20flash":         "gemini-2.0-flash",
    "gemini20flashlite":    "gemini-2.0-flash-lite",
    "gemini25proexp0325": "gemini-2.5-pro-exp-03-25",
};

// Define the KEY (from ALLOWED_MODELS) for the default model
// Make sure this key exists in ALLOWED_MODELS
const DEFAULT_MODEL_KEY = "gemini20flash";
// Ensure fallback uses a known valid key if the default key is somehow wrong or model unavailable
const DEFAULT_MODEL_ID = ALLOWED_MODELS[DEFAULT_MODEL_KEY] || Object.values(ALLOWED_MODELS)[0] || "gemini-1.5-flash";

// Generate the list of commands for help text and registration
const MODEL_COMMANDS = Object.keys(ALLOWED_MODELS).map(cmd => `/${cmd}`);
const EDIT_THROTTLE_MS = 1500; // Throttle edits to avoid Telegram limits

// --- Gemini Setup ---
const genAI = new GoogleGenerativeAI(process.env.API_KEY);
const SAFETY_SETTINGS = [
    { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_NONE },
    { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_NONE },
    { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_NONE },
    { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_NONE },
];

// Function to get the model instance based on the command key
function getModelInstance(modelKey = DEFAULT_MODEL_KEY) {
    // Look up the ID using the key, fallback to default key if invalid key provided
    const requestedModelId = ALLOWED_MODELS[modelKey];
    const defaultModelIdToUse = ALLOWED_MODELS[DEFAULT_MODEL_KEY] || Object.values(ALLOWED_MODELS)[0] || "gemini-1.5-flash"; // Safest fallback
    const modelId = requestedModelId || defaultModelIdToUse;
    const effectiveKey = requestedModelId ? modelKey : DEFAULT_MODEL_KEY; // Log the key that led to the modelId

    console.log(`Attempting to use model ID: ${modelId} (selected key: ${effectiveKey})`);
    try {
        // Check if modelId is actually defined before proceeding
        if (!modelId) {
             throw new Error(`Model ID is undefined for key ${effectiveKey}`);
        }
        return genAI.getGenerativeModel({
            model: modelId,
            safetySettings: SAFETY_SETTINGS,
            // generationConfig: { temperature: 0.7 } // Optional: Add if needed
        });
    } catch (error) {
        console.error(`Failed to get model instance for ID: ${modelId} (key: ${effectiveKey})`, error);
        // Fallback to the determined safe default model instance
        console.warn(`Falling back to default model: ${defaultModelIdToUse}`);
        return genAI.getGenerativeModel({
            model: defaultModelIdToUse,
            safetySettings: SAFETY_SETTINGS,
        });
    }
}

// --- User and State Management ---

// --- >>>> START MULTI-USER CHANGE <<<< ---
// Читаем строку ID из .env, разделенную запятыми
const allowedUserIdsString = process.env.ALLOWED_USER_IDS || '';

// Преобразуем строку в массив чисел (ID)
const allowedUserIds = allowedUserIdsString
    .split(',') // Разделяем по запятой
    .map(id => id.trim()) // Убираем лишние пробелы вокруг ID
    .filter(id => id.length > 0) // Убираем пустые строки (если были двойные запятые)
    .map(id => parseInt(id, 10)) // Преобразуем строки в числа
    .filter(id => !isNaN(id)); // Убираем значения, которые не удалось преобразовать в число

// Для быстрой проверки используем Set
const allowedUserIdsSet = new Set(allowedUserIds);

if (allowedUserIdsSet.size === 0) {
    console.warn("ПРЕДУПРЕЖДЕНИЕ: Список разрешенных пользователей (ALLOWED_USER_IDS в .env) пуст или не задан! Бот не будет отвечать никому.");
} else {
    // Этот лог будет выведен при запуске в блоке bot.launch()
}
// --- >>>> END MULTI-USER CHANGE <<<< ---


// Store history and user settings (Map<userId, { history: Array<any>, currentModelKey: string }>)
const userState = new Map();

function getUserState(userId) {
    if (!userState.has(userId)) {
        // Store the KEY of the model, not the ID
        userState.set(userId, { history: [], currentModelKey: DEFAULT_MODEL_KEY });
    }
    return userState.get(userId);
}

function clearConversationHistory(userId) {
    const state = getUserState(userId);
    state.history = []; // Only clear history, keep model setting
    console.log(`История для пользователя ${userId} очищена.`);
}

function addMessageToHistory(userId, role, content) {
    const state = getUserState(userId);
    // Optional: Limit history size
    // const MAX_HISTORY_LENGTH = 20;
    // if (state.history.length >= MAX_HISTORY_LENGTH) {
    //     state.history.splice(0, state.history.length - MAX_HISTORY_LENGTH + 1);
    // }
    state.history.push({ role, parts: content });
}

function setUserModel(userId, modelCommand) {
    const modelKey = modelCommand.startsWith('/') ? modelCommand.substring(1) : modelCommand;
    if (ALLOWED_MODELS[modelKey]) { // Check if the key exists in our allowed models
        const state = getUserState(userId);
        state.currentModelKey = modelKey; // Store the validated command key
        const modelId = ALLOWED_MODELS[modelKey]; // Get the corresponding ID
        console.log(`Пользователь ${userId} переключился на модель: ${modelId} (команда /${modelKey})`);
        // Verify the model instance can be created (optional, but good check)
        try {
            getModelInstance(modelKey); // Try creating it
        } catch (verificationError) {
            // Error already logged in getModelInstance
            return null; // Indicate failure if verification fails
        }
        return modelId; // Return the model ID for confirmation message
    }
    console.warn(`Попытка установить невалидный ключ модели: ${modelKey} для пользователя ${userId}`);
    return null; // Indicate failure
}

// --- Telegraf Bot Setup ---
const bot = new Telegraf(process.env.BOT_TOKEN);

// --- Middleware for Access Control ---
// --- >>>> START MULTI-USER CHANGE <<<< ---
bot.use((ctx, next) => {
    // Проверяем, есть ли ID пользователя в нашем наборе разрешенных ID
    if (ctx.from && allowedUserIdsSet.has(ctx.from.id)) {
        // ID найден в списке разрешенных, пропускаем дальше
        return next();
    }

    // Пользователь не авторизован
    console.log(`Запрос от неавторизованного пользователя: ${ctx.from?.id} (${ctx.from?.username})`);
    if (ctx.message || ctx.callback_query) {
        // Отвечаем только если есть сообщение или колбэк (чтобы не спамить в логи на другие события)
        return ctx.reply("Извините, у вас нет доступа к этому боту.");
    }
    // Игнорируем другие типы апдейтов от неавторизованных пользователей (например, вступление в группу)
});
// --- >>>> END MULTI-USER CHANGE <<<< ---

// --- Bot Commands ---

bot.start((ctx) => {
    const state = getUserState(ctx.from.id);
    // Look up the current model ID using the stored key
    const currentModelId = ALLOWED_MODELS[state.currentModelKey] || DEFAULT_MODEL_ID;
    ctx.reply(`Привет! Я твой личный помощник на основе Gemini (текущая модель: ${currentModelId}).
Спрашивай что угодно! Я могу анализировать текст, изображения, документы и аудио.
Используй /help для списка команд.`);
});

bot.command('clear', (ctx) => {
    clearConversationHistory(ctx.from.id);
    ctx.reply("История диалога очищена.");
});

bot.command('help', (ctx) => {
    const state = getUserState(ctx.from.id);
    // Look up the current model ID using the stored key for display
    const currentModelId = ALLOWED_MODELS[state.currentModelKey] || DEFAULT_MODEL_ID;
    let helpText = `🤖 *Доступные команды:*\n\n`;
    helpText += `/clear - Очистить историю диалога\n`;
    helpText += `/help - Показать это сообщение\n\n`;
    helpText += `*Выбор модели Gemini:*\n`;
    MODEL_COMMANDS.forEach(cmd => {
        const commandKey = cmd.substring(1); // e.g., "gemini15flash"
        const modelId = ALLOWED_MODELS[commandKey] || 'N/A'; // Get the ID for display, fallback N/A
        // Compare the stored key with the current command's key
        const isCurrent = state.currentModelKey === commandKey;
        helpText += `${cmd} - Переключиться на модель ${modelId}${isCurrent ? ' *(текущая)*' : ''}\n`;
    });
    helpText += `\nТекущая модель: *${currentModelId}*`; // Display the ID

    ctx.replyWithMarkdown(helpText);
});

// --- Model Switching Commands ---
MODEL_COMMANDS.forEach(command => {
    const commandKey = command.substring(1); // Get the key like "gemini15flash"
    bot.command(commandKey, (ctx) => { // Register the command using the key
        const userId = ctx.from.id;
        const chosenModelId = setUserModel(userId, commandKey); // Pass the key directly
        if (chosenModelId) {
            ctx.reply(`✅ Модель успешно переключена на: ${chosenModelId}`);
        } else {
             // Error trying to set the model (e.g., invalid ID from getModelInstance check)
             const failedModelIdAttempt = ALLOWED_MODELS[commandKey] || commandKey; // Show what was attempted
             ctx.reply(`⚠️ Не удалось переключиться на модель с ID "${failedModelIdAttempt}". Проверьте доступность модели или API ключ. Возвращаемся к ${DEFAULT_MODEL_ID}.`);
             // Revert to default if setting failed
             try {
                const state = getUserState(userId);
                state.currentModelKey = DEFAULT_MODEL_KEY;
             } catch (stateError) {
                console.error("Error reverting state to default after failed model switch:", stateError);
             }
        }
    });
});


// --- Streaming Function ---
async function streamAndEditResponse(ctx, stream, initialMessageId) {
    let fullResponseText = '';
    let lastSentText = '...'; // Text in the sent message placeholder
    let editTimeoutId = null;
    let lastEditTime = 0;
    let editAttemptScheduled = false; // Flag to track if an edit is pending

    const editMessage = async (textToEdit) => {
        editAttemptScheduled = false; // Mark attempt as happening/done
        const cleanText = textToEdit.trim();
        // Only edit if clean text is not empty and differs from the last sent text
        if (cleanText && cleanText !== lastSentText) {
            try {
                await ctx.telegram.editMessageText(ctx.chat.id, initialMessageId, null, cleanText);
                lastSentText = cleanText; // Update last sent text on success
                lastEditTime = Date.now();
                console.log(`Сообщение ${initialMessageId} отредактировано.`);
            } catch (error) {
                if (error.response && error.response.error_code === 429) {
                    console.warn(`Ошибка 429 (Too Many Requests) при редактировании сообщения ${initialMessageId}. Текст будет обновлен позже.`);
                    // Don't update lastSentText, let the next attempt send the fuller text
                    // Reschedule the edit slightly later? Or rely on the next chunk/final edit.
                    // For now, we'll rely on the next chunk triggering a new attempt.
                    editAttemptScheduled = true; // Indicate we need to try again
                } else if (error.message.includes('message is not modified')) {
                     console.warn(`Сообщение ${initialMessageId} не изменено (API 400), пропуск редактирования.`);
                     lastSentText = cleanText; // Assume it's sent to avoid re-trying the same text
                     lastEditTime = Date.now();
                } else if (error.message.includes('message to edit not found')) {
                    console.error(`Сообщение ${initialMessageId} для редактирования не найдено (возможно, удалено). Прекращение редактирования.`);
                    throw error; // Propagate error to stop the streaming loop for this message
                } else {
                    console.error(`Неизвестная ошибка при редактировании сообщения ${initialMessageId}:`, error);
                    // Log error but potentially allow further edits
                }
            }
        }
        // Only clear timeout ID if the edit wasn't rate-limited and needs rescheduling
        if (!editAttemptScheduled) {
            editTimeoutId = null;
        }
    };

    try {
        for await (const chunk of stream) {
            const chunkText = chunk.text();
            if (chunkText) {
                fullResponseText += chunkText;
            }

            // If an edit isn't already scheduled or pending retry, schedule one
            if (!editAttemptScheduled) {
                // Clear any previously scheduled timeout (e.g., if chunks arrive fast)
                if (editTimeoutId) {
                    clearTimeout(editTimeoutId);
                }

                const timeSinceLastEdit = Date.now() - lastEditTime;
                const delay = Math.max(0, EDIT_THROTTLE_MS - timeSinceLastEdit);

                editAttemptScheduled = true; // Mark that we are scheduling an attempt
                editTimeoutId = setTimeout(() => {
                    editMessage(fullResponseText).catch(err => {
                        console.error("Ошибка в запланированном editMessage:", err);
                        // If message not found, stream loop will break via propagated error
                        // If other error, reset flag to allow next chunk to try again
                        if (!err.message?.includes('message to edit not found')) {
                           editAttemptScheduled = false; // Allow scheduling again
                        }
                    });
                }, delay);
            }
        }

        // Stream finished. Handle final edit.

        // If an edit was scheduled but hasn't run yet, clear timeout and run immediately.
        if (editTimeoutId) {
            clearTimeout(editTimeoutId);
            editTimeoutId = null;
            console.log(`Выполнение финального редактирования для ${initialMessageId} после завершения стрима.`);
            // Wait for the final edit to complete or fail
            await editMessage(fullResponseText);
        }
        // If the last attempt failed (e.g., 429) or text changed since last success, try one last time.
        else if (fullResponseText.trim() && fullResponseText.trim() !== lastSentText) {
            console.log(`Попытка финального редактирования (текст отличается) для ${initialMessageId}.`);
            await editMessage(fullResponseText);
        } else {
            console.log(`Финальное редактирование для ${initialMessageId} не требуется.`);
        }

    } catch (streamError) {
        if (streamError.message.includes('message to edit not found')) {
            // Already logged in editMessage, just stop.
        } else {
            console.error("Ошибка во время стриминга ответа:", streamError);
            fullResponseText += "\n\n[Ошибка обработки стрима]";
            try {
                // Attempt to edit the message to show the stream error
                await ctx.telegram.editMessageText(ctx.chat.id, initialMessageId, null, fullResponseText.trim());
            } catch (editError) {
                 if (!editError.message.includes('message to edit not found')) {
                    console.error("Не удалось отредактировать сообщение для показа ошибки стрима:", editError);
                 }
            }
        }
    }

    // Return the full text, even if editing failed, for history
    return fullResponseText.trim();
}


// --- Message Handlers ---

bot.on('text', async (ctx) => {
    const userId = ctx.from.id;
    const userMessage = ctx.message.text;

    // Ignore commands
    if (userMessage.startsWith('/')) {
        // Check if it's NOT a model command (already handled) or other known commands
        const knownCommands = ['/start', '/clear', '/help', ...MODEL_COMMANDS];
        if (!knownCommands.includes(userMessage.split(' ')[0])) {
             ctx.reply("Неизвестная команда. Используйте /help для списка команд.");
        }
        return;
    }


    const userCtxState = getUserState(userId);
    addMessageToHistory(userId, "user", [{ text: userMessage }]);

    let sentMessage;
    try {
        sentMessage = await ctx.reply("..."); // Send placeholder message
        const messageId = sentMessage.message_id;

        // Get the correct model instance based on user's current setting
        const currentModel = getModelInstance(userCtxState.currentModelKey);

        // Start a chat session with history EXCLUDING the current user message
        const chat = currentModel.startChat({
            history: userCtxState.history.slice(0, -1),
        });

        // Send only the current user message to continue the chat
        const result = await chat.sendMessageStream(userMessage);

        // Stream the response and edit the placeholder message
        const finalResponseText = await streamAndEditResponse(ctx, result.stream, messageId);

        // Add the final model response to history if it's not empty
        if (finalResponseText) {
            addMessageToHistory(userId, "model", [{ text: finalResponseText }]);
        } else {
             console.warn("Получен пустой ответ от модели для текстового сообщения.");
             addMessageToHistory(userId, "model", [{ text: "[Пустой ответ от модели]" }]);
             try {
                 // Edit placeholder to indicate failure
                 await ctx.telegram.editMessageText(ctx.chat.id, messageId, null, "Не удалось получить ответ от модели.");
             } catch (e) {
                 if (!e.message?.includes('message to edit not found')) {
                    console.error("Не удалось изменить сообщение об ошибке (текст):", e);
                 }
             }
        }

    } catch (error) {
        console.error("Ошибка при обработке текстового сообщения:", error);
        const errorText = `Произошла ошибка при обработке вашего запроса. Модель: ${ALLOWED_MODELS[userCtxState.currentModelKey] || DEFAULT_MODEL_ID}. Ошибка: ${error.message || error}`;
        // Remove the failed user message from history
        if (userCtxState.history.length > 0 && userCtxState.history[userCtxState.history.length - 1].role === 'user') {
            userCtxState.history.pop();
        }
        if (sentMessage) {
            try {
                await ctx.telegram.editMessageText(ctx.chat.id, sentMessage.message_id, null, errorText);
            } catch (editError) {
                console.error("Не удалось отредактировать сообщение для показа ошибки:", editError);
                // Send as new message if editing failed (and original wasn't deleted)
                if (!editError.message?.includes('message to edit not found')) {
                    await ctx.reply(errorText);
                }
            }
        } else {
            await ctx.reply(errorText); // If sending placeholder failed
        }
    }
});

// --- File Handlers ---

// Helper function to fetch file buffer from Telegram
async function getFileBuffer(ctx, fileId) {
    const fileLink = await ctx.telegram.getFileLink(fileId);
    const response = await fetch(fileLink);
    if (!response.ok) {
        throw new Error(`Ошибка загрузки файла (${response.status}): ${response.statusText}`);
    }
    const arrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer);
}

// General file handler function
async function handleFile(ctx, fileId, mimeType, userPrompt, fileTypeName, fileName = '') {
    const userId = ctx.from.id;
    const userCtxState = getUserState(userId);
    let sentMessage;

    // Add user request (prompt + placeholder for file data) to history FIRST
    // The actual file data will be sent in the API request, not stored in history map
    const placeholderPart = { text: `[${fileTypeName} ${fileName || ''} received, processing...]` }; // Ensure fileName exists
    addMessageToHistory(userId, "user", [{ text: userPrompt }, placeholderPart]);

    try {
        sentMessage = await ctx.reply(`Анализирую ${fileTypeName} ${fileName}...`);
        const messageId = sentMessage.message_id;

        // Download the file content
        const buffer = await getFileBuffer(ctx, fileId);
        const filePart = {
            inlineData: { data: buffer.toString("base64"), mimeType: mimeType }
        };

        // Get the correct model instance
        const currentModel = getModelInstance(userCtxState.currentModelKey);

        // Prepare the request content for generateContentStream
        // Send the entire history including the user prompt + the actual file part
        const currentRequestContent = { role: 'user', parts: [{ text: userPrompt }, filePart] };
        const requestContent = {
             // History excluding the placeholder message we added
             contents: [...userCtxState.history.slice(0, -1), currentRequestContent]
        };

        // Call generateContentStream
        const result = await currentModel.generateContentStream(requestContent);

        // Stream the response and edit the message
        const finalResponseText = await streamAndEditResponse(ctx, result.stream, messageId);

        // Add successful model response to history
        if (finalResponseText) {
            addMessageToHistory(userId, "model", [{ text: finalResponseText }]);
        } else {
            console.warn(`Получен пустой ответ от модели для ${fileTypeName} ${fileName}.`);
            addMessageToHistory(userId, "model", [{ text: "[Пустой ответ от модели]" }]);
            try {
                await ctx.telegram.editMessageText(ctx.chat.id, messageId, null, `Не удалось проанализировать ${fileTypeName} ${fileName}.`);
            } catch (e) {
                 if (!e.message?.includes('message to edit not found')) {
                     console.error(`Не удалось изменить сообщение об ошибке (${fileTypeName}):`, e);
                 }
            }
        }

    } catch (error) {
        console.error(`Ошибка при обработке ${fileTypeName} ${fileName}:`, error);
        const errorText = `Произошла ошибка при обработке ${fileTypeName} ${fileName}. Модель: ${ALLOWED_MODELS[userCtxState.currentModelKey] || DEFAULT_MODEL_ID}. Ошибка: ${error.message || error}`;
        // Remove the failed user message (with placeholder) from history
        if (userCtxState.history.length > 0 && userCtxState.history[userCtxState.history.length - 1].role === 'user') {
            userCtxState.history.pop();
        }
         if (sentMessage) {
            try {
                await ctx.telegram.editMessageText(ctx.chat.id, sentMessage.message_id, null, errorText);
            } catch (editError) {
                 console.error("Не удалось отредактировать сообщение для показа ошибки:", editError);
                 if (!editError.message?.includes('message to edit not found')) {
                    await ctx.reply(errorText);
                 }
            }
        } else {
            await ctx.reply(errorText); // If sending placeholder failed
        }
    }
}

// Specific file type listeners
bot.on('photo', async (ctx) => {
    // Use the highest resolution photo
    const fileId = ctx.message.photo[ctx.message.photo.length - 1].file_id;
    const mimeType = 'image/jpeg'; // Assume JPEG for Telegram photos
    const userPrompt = ctx.message.caption || " ";
    await handleFile(ctx, fileId, mimeType, userPrompt, "изображение");
});

// List of supported MIME types for documents (adjust as needed)
const supportedMimeTypes = [
    'text/plain', 'application/pdf', 'image/png', 'image/jpeg', 'text/csv',
    'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', // doc, docx
    'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', // xls, xlsx
    // Add video/audio types if needed and supported by the Gemini model
    'audio/mpeg', 'audio/ogg', 'audio/wav', // Common audio formats
    // 'video/mp4', 'video/quicktime', // Common video formats - uncomment if needed
];

bot.on('document', async (ctx) => {
    const fileId = ctx.message.document.file_id;
    const mimeType = ctx.message.document.mime_type;
    const fileName = ctx.message.document.file_name || 'документ';

    if (!mimeType || !supportedMimeTypes.includes(mimeType)) {
        console.log(`Попытка загрузить неподдерживаемый тип документа: ${mimeType} (${fileName})`);
        return ctx.reply(`Извините, я не поддерживаю файлы (${fileName}) с MIME-типом: ${mimeType || 'не определен'}. Поддерживаемые типы: ${supportedMimeTypes.join(', ')}`);
    }

    const userPrompt = ctx.message.caption || `Проанализируй содержимое файла "${fileName}".`;
    await handleFile(ctx, fileId, mimeType, userPrompt, "документ", `"${fileName}"`);
});

bot.on('voice', async (ctx) => {
    const fileId = ctx.message.voice.file_id;
    // Telegram voice messages are often opus in ogg container
    const mimeType = ctx.message.voice.mime_type || 'audio/ogg';
    const userPrompt = " "; // Changed prompt to be more specific
    await handleFile(ctx, fileId, mimeType, userPrompt, "голосовое сообщение");
});

// --- Error Handling and Restart Logic ---

let consecutiveCrashCount = 0;
const MAX_CONSECUTIVE_CRASHES = 5;
let lastCrashTime = 0;

const handleCriticalError = (error, origin) => {
    console.error(`\n====================================`);
    console.error(`CRITICAL ERROR DETECTED (${origin})`);
    console.error(`Time: ${new Date().toISOString()}`);
    console.error(error.stack || error);
    console.error(`====================================\n`);


    const now = Date.now();
    // Reset counter if the last crash was more than a minute ago
    if (now - lastCrashTime > 60000) {
        consecutiveCrashCount = 0;
    }

    lastCrashTime = now;
    consecutiveCrashCount++;

    console.error(`Consecutive crash count: ${consecutiveCrashCount}/${MAX_CONSECUTIVE_CRASHES}`);

    if (consecutiveCrashCount >= MAX_CONSECUTIVE_CRASHES) {
        console.error(`Max consecutive crash limit reached. Forcing shutdown (exit code 0). PM2 should NOT restart.`);
        // Attempt graceful stop, then exit with 0
        bot.stop('CRITICAL_ERROR_LIMIT');
        setTimeout(() => process.exit(0), 1500);
    } else {
        console.error('Attempting graceful shutdown for restart (exit code 1). PM2 should restart.');
        // Attempt graceful stop, then exit with 1
        bot.stop('CRITICAL_ERROR_RESTART');
        setTimeout(() => process.exit(1), 1500); // Give time for stop signal
    }
};

// Catch unhandled promise rejections
process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise);
    handleCriticalError(reason instanceof Error ? reason : new Error(String(reason)), 'unhandledRejection');
});

// Catch uncaught exceptions
process.on('uncaughtException', (err, origin) => {
    console.error('Uncaught Exception:', origin);
    handleCriticalError(err, origin);
});


// --- Bot Launch ---
bot.launch().then(() => {
    console.log('------------------------------------');
    console.log('Бот успешно запущен!');
    // --- >>>> START MULTI-USER CHANGE <<<< ---
    // Display resolved user IDs at launch
    if (allowedUserIdsSet.size > 0) {
        console.log(`Разрешенные пользователи (ID): ${[...allowedUserIdsSet].join(', ')}`);
    } else {
         console.warn("ПРЕДУПРЕЖДЕНИЕ: Список разрешенных пользователей (ALLOWED_USER_IDS в .env) пуст!");
    }
    // --- >>>> END MULTI-USER CHANGE <<<< ---
    console.log(`Модель по умолчанию: ${DEFAULT_MODEL_ID} (ключ: ${DEFAULT_MODEL_KEY})`);
    console.log(`Доступные модели (команды):`);
    MODEL_COMMANDS.forEach(cmd => {
        const key = cmd.substring(1);
        console.log(`  ${cmd} -> ${ALLOWED_MODELS[key] || 'N/A'}`); // Added fallback for safety
    });
    console.log('Ожидание сообщений...');
    console.log('------------------------------------');
    consecutiveCrashCount = 0; // Reset crash count on successful launch
}).catch(err => {
    console.error('Критическая ошибка при запуске бота:', err);
    handleCriticalError(err, 'botLaunch'); // Trigger restart logic if launch fails
});

// --- Graceful Shutdown Signals ---
const gracefulStop = (signal) => {
     console.log(`\nПолучен сигнал ${signal}. Останавливаю бота...`);
     // pm2 sends SIGINT, nodemon sends SIGUSR2, etc.
     bot.stop(signal);
     console.log('Бот остановлен.');
     process.exit(0); // Exit cleanly
};

process.once('SIGINT', () => gracefulStop('SIGINT'));
process.once('SIGTERM', () => gracefulStop('SIGTERM'));
process.once('SIGUSR2', () => gracefulStop('SIGUSR2')); // Often used by nodemon

console.log("--- Инициализация бота завершена. Запускаю... ---");

/*
--- Использование с PM2 для авто-рестарта ---

1. Установите PM2 глобально:
   npm install pm2 -g

2. Создайте файл ecosystem.config.cjs (используйте .cjs если package.json имеет "type": "module"):

   module.exports = {
     apps : [{
       name: 'gemini-bot',       // Имя процесса в PM2
       script: 'bot.js',         // Имя вашего файла с кодом бота
       instances: 1,             // Запускать один экземпляр
       autorestart: true,        // Автоматически перезапускать при падении (exit code != 0)
       watch: false,             // Не перезапускать при изменении файлов (можно включить для разработки: true)
       max_memory_restart: '512M', // Перезапуск, если процесс съест > 512MB RAM
       // Настройки для предотвращения слишком частых перезапусков:
       max_restarts: 5,          // Макс. кол-во перезапусков в короткий промежуток времени
       min_uptime: '60s',        // Считать запуск стабильным, если проработал 60 секунд
       restart_delay: 5000,      // Задержка 5 секунд перед попыткой перезапуска
       // Логирование (опционально)
       // output: './logs/out.log',
       // error: './logs/error.log',
       // log_date_format: 'YYYY-MM-DD HH:mm:ss Z'
     }]
   };

3. Запустите бота с помощью PM2 и файла конфигурации:
   pm2 start ecosystem.config.cjs

4. Мониторинг:
   pm2 list                # Показать все запущенные процессы
   pm2 monit               # Открыть панель мониторинга
   pm2 logs gemini-bot     # Показать логи конкретно этого бота

5. Управление:
   pm2 restart gemini-bot  # Перезапустить бота
   pm2 stop gemini-bot     # Остановить бота
   pm2 delete gemini-bot   # Остановить и удалить бота из списка PM2

6. Настройка автозапуска PM2 при старте системы (если нужно):
   pm2 startup             # Сгенерирует команду для вашей ОС
   # Выполните сгенерированную команду
   pm2 save                # Сохранить текущий список процессов для автозапуска

PM2 будет автоматически перезапускать скрипт, если он завершится с кодом 1 (как в handleCriticalError).
Если скрипт завершится с кодом 0 (чистый выход или достижение лимита MAX_CONSECUTIVE_CRASHES), PM2 его НЕ перезапустит.
*/