class MockJiraService {
  constructor() {
    this.issueCounter = 0;
  }

  async createIssue({ projectKey, summary, description, issueType = 'Task', priority = 'Medium' }) {
    this.issueCounter++;
    const issueKey = `${projectKey}-${this.issueCounter}`;
    
    return {
      key: issueKey,
      id: `mock-${issueKey}`,
      self: `https://mock-jira/rest/api/3/issue/${issueKey}`
    };
  }

  async getIssue(issueKey) {
    return {
      key: issueKey,
      id: `mock-${issueKey}`,
      self: `https://mock-jira/rest/api/3/issue/${issueKey}`,
      fields: {
        summary: 'Mock Issue',
        description: 'Mock Description',
        issuetype: { name: 'Task' },
        priority: { name: 'Medium' }
      }
    };
  }
}

// Export the class instead of an instance
module.exports = MockJiraService; 