import { Telegraf } from 'telegraf';
import { GoogleGenerativeAI, HarmBlockThreshold, HarmCategory } from "@google/generative-ai";
import fs from 'fs'; // fs остается как import, если используется
import fetch from 'node-fetch'; // fetch остается как import
import dotenv from 'dotenv';
dotenv.config();

// Настройка Gemini
const genAI = new GoogleGenerativeAI(process.env.API_KEY);
const model = genAI.getGenerativeModel({
    model: "gemini-1.5-flash",
    safetySettings: [ // safetySettings перемещены сюда, при создании модели
        {
            category: HarmCategory.HARM_CATEGORY_HARASSMENT,
            threshold: HarmBlockThreshold.BLOCK_NONE,
        },
        {
            category: HarmCategory.HARM_CATEGORY_HATE_SPEECH,
            threshold: HarmBlockThreshold.BLOCK_NONE,
        },
        {
            category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT,
            threshold: HarmBlockThreshold.BLOCK_NONE,
        },
        {
            category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT,
            threshold: HarmBlockThreshold.BLOCK_NONE,
        },
    ],
});

// ID пользователя, которому разрешено использовать бота
const allowedUserId = parseInt(process.env.ALLOWED_USER_ID);

// Хранилище истории диалога
const conversationHistory = new Map();

// ID последнего отправленного ботом сообщения (для редактирования)
const lastBotMessageIds = new Map();

// Таймеры для автоочистки чата
const clearChatTimers = new Map();

// Функция для очистки истории диалога
function clearConversationHistory(userId) {
    conversationHistory.delete(userId);
    lastBotMessageIds.delete(userId);
    if (clearChatTimers.has(userId)) {
        clearTimeout(clearChatTimers.get(userId));
        clearChatTimers.delete(userId);
    }
}

function addMessageToHistory(userId, role, content) {
    if (!conversationHistory.has(userId)) {
        conversationHistory.set(userId, []);
    }
    conversationHistory.get(userId).push({ role, parts: content });
}

const bot = new Telegraf(process.env.BOT_TOKEN);

bot.start((ctx) => {
    if (ctx.from.id !== allowedUserId) {
        return ctx.reply("Извините, у вас нет доступа к этому боту.");
    }
    ctx.reply("Привет! Я твой личный помощник на основе Gemini. Спрашивай что угодно! Я могу анализировать текст, изображения и аудио.");
});

function setClearChatTimer(userId) {
    if (clearChatTimers.has(userId)) {
        clearTimeout(clearChatTimers.get(userId));
    }

    const timerId = setTimeout(() => {
        clearConversationHistory(userId);
        bot.telegram.sendMessage(userId, "Чат очищен из-за неактивности.");
    }, 5 * 60 * 1000); // 5 минут

    clearChatTimers.set(userId, timerId);
}

bot.on('text', async (ctx) => {
    if (ctx.from.id !== allowedUserId) return;

    setClearChatTimer(ctx.from.id);

    const userMessage = ctx.message.text;
    addMessageToHistory(ctx.from.id, "user", [{ text: userMessage }]);

    try {
        // generationConfig удален отсюда
        const chat = model.startChat({
            history: conversationHistory.get(ctx.from.id) || [],
            // generationConfig  <--- удалено
        });

        const result = await chat.sendMessageStream(userMessage);
        let responseText = '';

        let messageId = null;
        const sentMessage = await ctx.reply("...");
        messageId = sentMessage.message_id;
        lastBotMessageIds.set(ctx.from.id, messageId);

        for await (const chunk of result.stream) {
            let chunkText = chunk.text();

            responseText += chunkText;
            try {
                if (responseText !== '' && responseText !== sentMessage.text) {
                    await ctx.telegram.editMessageText(ctx.chat.id, messageId, null, responseText);
                }
            } catch (error) {
                console.error('Ошибка при редактировании сообщения:', error);
            }
        }

        addMessageToHistory(ctx.from.id, "model", [{ text: responseText }]);
    } catch (error) {
        console.error("Error generating content:", error);
        addMessageToHistory(ctx.from.id, "model", [{ text: "Произошла ошибка при обработке запроса." }]);
        await ctx.reply("Произошла ошибка при обработке запроса.");
    }
});

bot.on('photo', async (ctx) => {
    if (ctx.from.id !== allowedUserId) return;

    setClearChatTimer(ctx.from.id);

    try {
        const fileId = ctx.message.photo[ctx.message.photo.length - 1].file_id;
        const fileLink = await bot.telegram.getFileLink(fileId);

        const response = await fetch(fileLink);
        const arrayBuffer = await response.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);

        const imagePart = {
            inlineData: {
                data: buffer.toString("base64"),
                mimeType: "image/jpeg"
            }
        };
        const userMessage = "Что изображено на картинке?";

        const history = (conversationHistory.get(ctx.from.id) || []).map(msg => ({
            role: msg.role === 'model' ? 'model' : 'user',
            parts: msg.parts,
        }));

        history.push({
            role: 'user',
            parts: [{ text: userMessage }, imagePart],
        });

        conversationHistory.set(ctx.from.id, history);

        // generationConfig удален отсюда
        const result = await model.generateContentStream({
            contents: history,
            // generationConfig,  <--- удалено
        });

        let responseText = '';

        let messageId = null;
        const sentMessage = await ctx.reply("...");
        messageId = sentMessage.message_id;
        lastBotMessageIds.set(ctx.from.id, messageId);

        for await (const chunk of result.stream) {
            const chunkText = chunk.text();
            responseText += chunkText;
            try {
                if (responseText !== '' && responseText !== sentMessage.text) {
                    await ctx.telegram.editMessageText(ctx.chat.id, messageId, null, responseText);
                }
            } catch (error) {
                console.error('Ошибка при редактировании сообщения:', error);
            }
        }

        addMessageToHistory(ctx.from.id, "model", [{ text: responseText }]);

    } catch (error) {
        console.error('Error processing image:', error);
        ctx.reply('Произошла ошибка при обработке изображения.');
    }
});

const supportedMimeTypes = [
    'text/plain',
    'application/pdf',
    'image/png',
    'image/jpeg',
    'text/csv',
];

bot.on('document', async (ctx) => {
    if (ctx.from.id !== allowedUserId) return;

    setClearChatTimer(ctx.from.id);

    try {
        const fileId = ctx.message.document.file_id;
        const mimeType = ctx.message.document.mime_type;

        if (!supportedMimeTypes.includes(mimeType)) {
            return ctx.reply(`Извините, я не поддерживаю файлы с MIME-типом ${mimeType}.`);
        }

        const fileLink = await bot.telegram.getFileLink(fileId);
        const response = await fetch(fileLink);
        const fileBuffer = await response.arrayBuffer();
        const filePart = {
            inlineData: {
                data: Buffer.from(fileBuffer).toString("base64"),
                mimeType: mimeType
            }
        };

        const lastUserMessage = conversationHistory.get(ctx.from.id)?.slice(-1).find(m => m.role === "user");
        const prompt = lastUserMessage ? lastUserMessage.parts[0].text : "Что содержится в этом файле?";

        const history = (conversationHistory.get(ctx.from.id) || []).map(msg => ({
            role: msg.role === 'model' ? 'model' : 'user',
            parts: msg.parts,
        }));

        history.push({
            role: 'user',
            parts: [{ text: prompt }, filePart],
        });

        conversationHistory.set(ctx.from.id, history);

        // generationConfig удален отсюда
        const result = await model.generateContentStream({
            contents: history,
            // generationConfig,  <--- удалено
        });

        let responseText = '';

        let messageId = null;
        const sentMessage = await ctx.reply("...");
        messageId = sentMessage.message_id;
        lastBotMessageIds.set(ctx.from.id, messageId);

        for await (const chunk of result.stream) {
            const chunkText = chunk.text();
            responseText += chunkText;
            try {
                if (responseText !== '' && responseText !== sentMessage.text) {
                    await ctx.telegram.editMessageText(ctx.chat.id, messageId, null, responseText);
                }
            } catch (error) {
                console.error('Ошибка при редактировании сообщения:', error);
            }
        }

        addMessageToHistory(ctx.from.id, "model", [{ text: responseText }]);

    } catch (error) {
        console.error('Error processing document:', error);
        ctx.reply('Произошла ошибка при обработке документа.');
    }
});

bot.on('voice', async (ctx) => {
    if (ctx.from.id !== allowedUserId) return;

    setClearChatTimer(ctx.from.id);

    try {
        const fileId = ctx.message.voice.file_id;
        const mimeType = ctx.message.voice.mime_type;
        const fileLink = await bot.telegram.getFileLink(fileId);

        const response = await fetch(fileLink);
        const fileBuffer = await response.arrayBuffer();

        const fileContent = {
            inlineData: {
                data: Buffer.from(fileBuffer).toString('base64'),
                mimeType: mimeType,
            },
        };

        const prompt = "Проанализируй это аудио сообщение";

        // generationConfig удален отсюда
        const result = await model.generateContentStream({
            contents: [
                {
                    role: 'user',
                    parts: [
                        { text: prompt },
                        fileContent,
                    ],
                },
            ],
            // generationConfig,  <--- удалено
        });

        let responseText = '';
        let messageId = null;
        const sentMessage = await ctx.reply("...");
        messageId = sentMessage.message_id;
        lastBotMessageIds.set(ctx.from.id, messageId);

        for await (const chunk of result.stream) {
            const chunkText = chunk.text();
            responseText += chunkText;
            try {
                if (responseText !== '' && responseText !== sentMessage.text) {
                    await ctx.telegram.editMessageText(ctx.chat.id, messageId, null, responseText);
                }
            } catch (error) {
                console.error('Ошибка при редактировании сообщения:', error);
            }
        }

        addMessageToHistory(ctx.from.id, "model", [{ text: responseText }]);
    } catch (error) {
        console.error('Error processing voice message:', error);
        ctx.reply('Произошла ошибка при обработке голосового сообщения.');
    }
});

bot.launch();

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
