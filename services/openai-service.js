const OpenAI = require('openai');

class OpenAIService {
  constructor() {
    this.client = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY
    });
  }

  async analyzeFeedback(messages) {
    try {
      const response = await this.client.chat.completions.create({
        model: process.env.OPENAI_MODEL || 'gpt-4o',
        messages: [
          {
            role: 'system',
            content: `You are a product feedback analyzer. Your task is to identify product feedback from conversations and structure them into actionable items.

When analyzing messages:
- Identify specific product feedback, feature requests, or bug reports
- Ignore general discussion or non-feedback messages
- Structure feedback into:
  - Title: Brief, descriptive title
  - Type: BUG, FEATURE, or IMPROVEMENT
  - Priority: HIGH, MEDIUM, or LOW
  - Description: Detailed explanation
  - User Impact: How this affects users
  - Current Behavior: What currently happens (for bugs)
  - Expected Behavior: What should happen
  - Additional Context: Any other relevant information

Return JSON array of feedback items.`
          },
          {
            role: 'user',
            content: `Analyze these messages for product feedback: ${JSON.stringify(messages)}`
          }
        ],
        temperature: 0.1,
        response_format: { type: "json_object" }
      });

      const result = JSON.parse(response.choices[0].message.content);
      
      // Transform to our expected format with only snake_case fields
      return {
        items: result.feedback.map(({ 
          title, 
          type, 
          priority, 
          description,
          userImpact,
          currentBehavior,
          expectedBehavior,
          additionalContext
        }) => ({
          title,
          type,
          priority,
          description,
          user_impact: userImpact,
          current_behavior: currentBehavior,
          expected_behavior: expectedBehavior,
          additional_context: additionalContext
        }))
      };
    } catch (error) {
      console.error('Error analyzing feedback:', error);
      throw error;
    }
  }
}

module.exports = new OpenAIService();