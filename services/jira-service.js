const JiraApi = require('jira-client');

class JiraService {
  constructor() {
    const host = process.env.JIRA_HOST?.replace(/^https?:\/\//, '');

    this.client = new JiraApi({
      protocol: 'https',
      host: host,
      username: process.env.JIRA_USERNAME,
      password: process.env.JIRA_API_TOKEN,
      apiVersion: '3',
      strictSSL: true
    });
  }

  async createIssue({ projectKey, summary, description, issueType = 'Task', priority = 'Medium' }) {
    try {
      const issue = await this.client.addNewIssue({
        fields: {
          project: { key: projectKey },
          summary,
          description,
          issuetype: { name: issueType },
          priority: { name: priority }
        }
      });

      return {
        key: issue.key,
        id: issue.id,
        self: issue.self
      };
    } catch (error) {
      console.error('Error creating Jira issue:', error);
      throw error;
    }
  }

  async getIssue(issueKey) {
    return this.client.findIssue(issueKey);
  }
}

module.exports = new JiraService(); 