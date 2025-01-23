class MockSlackClient {
  constructor() {
    this.messages = new Map();
    this.channels = new Map([
      ['C123456', { name: 'general', members: ['U1', 'U2'] }],
      ['C789012', { name: 'random', members: ['U1', 'U3'] }]
    ]);
    this.users = new Map([
      ['U1', { real_name: 'Test User 1', profile: { email: 'user1@test.com' } }],
      ['U2', { real_name: 'Test User 2', profile: { email: 'user2@test.com' } }]
    ]);

    // Initialize conversations methods
    this.conversations = {
      history: async ({ channel, oldest, latest }) => {
        return {
          ok: true,
          messages: [
            {
              user: 'U1',
              text: 'Test message 1',
              ts: '1643673600.000000' // 2024-01-01
            },
            {
              user: 'U2',
              text: 'Test message 2',
              ts: '1643760000.000000' // 2024-01-02
            }
          ]
        };
      },

      join: async ({ channel }) => {
        if (!this.channels.has(channel)) {
          throw new Error('Channel not found');
        }
        return { ok: true };
      }
    };

    // Initialize users methods
    this.users = {
      info: async ({ user }) => {
        const userInfo = this.users.get(user);
        if (!userInfo) {
          throw new Error('User not found');
        }
        return { ok: true, user: userInfo };
      }
    };
  }
}

module.exports = MockSlackClient; 