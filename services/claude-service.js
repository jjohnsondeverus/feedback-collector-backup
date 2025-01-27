const Anthropic = require('@anthropic-ai/sdk');

class ClaudeService {
  constructor(config = {}) {
    this.anthropic = new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY
    });
  }

  async analyzeFeedback(messages) {
    try {
      const response = await this.anthropic.messages.create({
        model: process.env.CLAUDE_MODEL || "claude-3-sonnet-20240229",
        max_tokens: 4096,
        temperature: 0,
        system: `You are a software development project manager analyzing potential issues.
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
          Do not combine or skip any valid issues.`,
        messages: [
          {
            role: "user",
            content: JSON.stringify(messages)
          }
        ],
        response_format: { type: "json" }
      });

      const result = JSON.parse(response.content[0].text);
      if (!Array.isArray(result)) {
        throw new Error('Invalid response format from Claude');
      }
      return result;
    } catch (error) {
      console.error('Error analyzing feedback with Claude:', error);
      throw error;
    }
  }
}

module.exports = { ClaudeService }; 