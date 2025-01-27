const { OpenAIService } = require('./openai-service');
const { ClaudeService } = require('./claude-service');

class LLMFactory {
  static createService(type = 'gpt') {
    switch (type.toLowerCase()) {
      case 'gpt':
        return new OpenAIService();
      case 'claude':
        return new ClaudeService();
      default:
        throw new Error(`Unknown LLM type: ${type}`);
    }
  }
}

module.exports = { LLMFactory }; 