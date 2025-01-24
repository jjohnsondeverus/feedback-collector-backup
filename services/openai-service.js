const OpenAI = require('openai');

class OpenAIService {
  constructor(config = {}) {
    this.openai = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY
    });
  }

  async analyzeFeedback(messages) {
    try {
      const response = await this.openai.chat.completions.create({
        model: process.env.OPENAI_MODEL || "gpt-4",
        messages: [
          {
            role: "system",
            content: `You are a product feedback analyzer. Extract feedback items from conversations.
              Format each item as:
              {
                "title": "Brief descriptive title",
                "summary": "Detailed explanation",
                "type": "bug|improvement|feature",
                "priority": "high|medium|low",
                "user_impact": "How this affects users",
                "current_behavior": "What currently happens",
                "expected_behavior": "What should happen",
                "additional_context": "Other relevant details"
              }
              Return a JSON object with a 'feedback' array containing these items.`
          },
          {
            role: "user",
            content: JSON.stringify(messages)
          }
        ],
        temperature: 0.1,
        response_format: { type: "json_object" }
      });

      const result = JSON.parse(response.choices[0].message.content);
      if (!result.feedback || !Array.isArray(result.feedback)) {
        throw new Error('Invalid response format from OpenAI');
      }
      return result;
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