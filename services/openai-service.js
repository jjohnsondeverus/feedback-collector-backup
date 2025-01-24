const OpenAI = require('openai');

class OpenAIService {
  constructor(config = {}) {
    this.openai = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY
    });
  }

  async analyzeFeedback(messages) {
    const response = await this.openai.chat.completions.create({
      model: process.env.OPENAI_MODEL || "gpt-4",
      messages: [
        {
          role: "system",
          content: "You are a helpful assistant that analyzes conversation messages and extracts structured feedback items."
        },
        {
          role: "user",
          content: JSON.stringify(messages)
        }
      ]
    });

    return JSON.parse(response.choices[0].message.content);
  }
}

module.exports = { OpenAIService };