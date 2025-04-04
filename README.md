# Telegram-бот на основе Google Gemini

Этот бот предоставляет доступ к возможностям Google Gemini прямо в Telegram. Он позволяет общаться с искусственным интеллектом, генерировать текст, анализировать изображения, документы и аудиофайлы.

## Возможности

-   **Текстовые запросы:**  Задавайте вопросы, генерируйте идеи, пишите тексты - всё, что может Gemini, доступно через текстовый чат.
-   **Обработка изображений:**  Отправляйте боту изображения и получайте их описание или ответы на вопросы, связанные с ними.
-   **Обработка документов:**  Загружайте документы в поддерживаемых форматах (текстовые файлы, PDF, изображения, CSV) и задавайте вопросы об их содержимом.
-   **Обработка аудио:**  Отправляйте голосовые сообщения, и бот проанализирует их содержание.
-   **Потоковая генерация ответа:**  Бот отвечает на сообщения по частям, что позволяет видеть результат генерации в реальном времени.
-   **Автоматическая очистка истории:**  История диалога автоматически очищается через 5 минут неактивности для экономии ресурсов и повышения производительности.

## Используемые технологии

-   **Google Gemini API:**  Используется последняя версия модели `gemini-1.5-flash` для генерации текста и анализа данных.
-   **Node.js:**  Бот написан на языке JavaScript с использованием платформы Node.js.
-   **Telegraf.js:**  Библиотека для создания Telegram-ботов.
-   **`@google/generative-ai`:**  Официальный SDK от Google для работы с Gemini API.

## Установка и запуск

1. **Клонируйте репозиторий:**

    ```bash
    git clone https://github.com/timurkaff/Telegram-bot-Google-Gemini-Ai.git
    cd <Telegram-bot-Google-Gemini-Ai>
    ```

2. **Установите зависимости:**

    ```bash
    npm install
    ```

3. **Настройте переменные окружения:**

    -   Создайте файл `.env` в корневой директории проекта.
    -   Добавьте в него следующие переменные:

        ```
        API_KEY=<ваш API ключ Google Gemini>
        BOT_TOKEN=<токен вашего Telegram бота>
        ALLOWED_USER_ID=<ваш Telegram ID>
        ```

        -   **`API_KEY`:**  Ключ API для доступа к Google Gemini. Получить его можно на [странице Google AI Studio](https://makersuite.google.com/app/apikey).
        -   **`BOT_TOKEN`:**  Токен Telegram-бота. Создать бота и получить токен можно с помощью [@BotFather](https://telegram.me/BotFather).
        -   **`ALLOWED_USER_ID`:**  Ваш Telegram ID. Узнать его можно с помощью [@userinfobot](https://telegram.me/userinfobot). Бот будет отвечать только пользователю с этим ID.

4. **Запустите бота:**

    ```bash
    node index.js
    ```

## Смена модели

Модель, используемая ботом, задаётся в файле `index.js` в строке:

```javascript
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
```

Чтобы сменить модель, замените `"gemini-1.5-flash"` на название другой модели, например:

-   `"gemini-pro"` - модель для текстовых задач.
-   `"gemini-1.5-pro"` - более новая версия модели, чем `gemini-pro`

**Важно:** Убедитесь, что выбранная модель поддерживает нужные вам функции. Например, `"gemini-pro"` не поддерживает работу с аудио. Актуальный список моделей и их возможностей можно найти в [документации Google AI](https://ai.google.dev/models/gemini).
Также можешь натсроить ответ модели для этого найди код 
```javascript
const generationConfig = {
      //настройки безопасности
      safetySettings: [
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
    };
```
и замени `BLOCK_NONE` на `BLOCK_LOW_AND_ABOVE`, `BLOCK_MEDIUM_AND_ABOVE`

## Ограничения

-   **Бесплатный тариф:**  В бесплатном тарифе Google Gemini API есть ограничения на количество запросов в минуту и в месяц.
-   **Поддерживаемые форматы файлов:**  Список поддерживаемых MIME-типов для документов можно найти в коде бота в переменной `supportedMimeTypes`.
-   **Размер файлов:**  Существуют ограничения на размер загружаемых файлов. Подробности можно найти в документации к Google Gemini API.



