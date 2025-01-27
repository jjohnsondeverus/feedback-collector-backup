class BaseLLMService {
  constructor() {
    if (this.constructor === BaseLLMService) {
      throw new Error("Can't instantiate abstract class!");
    }
  }

  async analyzeFeedback(messages) {
    throw new Error("Method 'analyzeFeedback()' must be implemented.");
  }

  validateResponse(response) {
    if (!Array.isArray(response)) {
      throw new Error('Expected array of issues');
    }

    const required = ['title', 'type', 'priority', 'user_impact', 'current_behavior', 'expected_behavior'];
    return response.filter(issue => 
      required.every(field => issue[field] && issue[field].trim().length > 0)
    );
  }
}

module.exports = { BaseLLMService }; 