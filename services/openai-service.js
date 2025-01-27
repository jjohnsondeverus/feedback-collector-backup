const OpenAI = require('openai');
const { BaseLLMService } = require('./base-llm-service');

class OpenAIService extends BaseLLMService {
  constructor(config = {}) {
    super();
    this.openai = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY
    });
  }

  async analyzeFeedback(messages) {
    try {
      const response = await this.openai.chat.completions.create({
        model: process.env.OPENAI_MODEL || "gpt-4o-2024-11-20",
        messages: [
          {
            role: "system",
            content: `You are a software development project manager analyzing potential issues.
              For each issue provided:
              1. Validate it meets these criteria:
                 - Clear technical problem or feature request
                 - Specific user/business impact
                 - Actionable solution possible
              2. If valid, extract:
                 - Clear title
                 - Issue type
                 - Priority based on impact
                 - Current and expected behavior
              3. If invalid, exclude it
              
              Return array of valid issues only.
              Process ALL issues independently.
              Do not combine or skip any valid issues.`
          },
          {
            role: "user",
            content: JSON.stringify(messages)
          }
        ],
        temperature: 0,
        response_format: { type: "json" }
      });

      const result = JSON.parse(response.choices[0].message.content);
      return this.validateResponse(result);
    } catch (error) {
      console.error('Error analyzing feedback:', error);
      if (error.message.includes('JSON')) {
        throw new Error('Failed to process feedback. Please try again.');
      }
      throw error;
    }
  }
}

module.exports = { OpenAIService };