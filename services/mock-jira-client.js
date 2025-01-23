class MockJiraClient {
  constructor() {
    this.tickets = new Map();
    this.ticketCounter = 1;
  }

  async addNewIssue(issueData) {
    const ticketKey = `TEST-${this.ticketCounter++}`;
    this.tickets.set(ticketKey, {
      ...issueData,
      key: ticketKey,
      created: new Date().toISOString()
    });

    return {
      key: ticketKey
    };
  }
}

module.exports = MockJiraClient; 