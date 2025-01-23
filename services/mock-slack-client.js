class MockSlackClient {
  constructor(config = {}) {
    this.conversations = {
      join: async ({ channel }) => {
        if (channel === 'C_PRIVATE') {
          throw { data: { error: 'is_private' } };
        }
        if (channel === 'C_NO_ACCESS') {
          throw { data: { error: 'not_in_channel' } };
        }
        if (channel === 'C_NO_PERMS') {
          throw { data: { error: 'missing_scope' } };
        }
        return { ok: true };
      },

      info: async ({ channel }) => {
        if (channel === 'C_PRIVATE') {
          return { channel: { is_private: true } };
        }
        if (channel === 'C_NO_INFO') {
          throw { data: { error: 'channel_not_found' } };
        }
        if (channel === 'C_NO_ACCESS') {
          throw { data: { error: 'not_in_channel' } };
        }
        return { channel: { is_private: false } };
      },

      history: async ({ channel }) => {
        if (channel === 'C_NO_ACCESS') {
          throw { data: { error: 'not_in_channel' } };
        }
        if (channel === 'C_NO_PERMS') {
          throw { data: { error: 'missing_scope' } };
        }
        return {
          messages: [
            { text: 'Test message 1', ts: '1234567890.000000' },
            { text: 'Test message 2', ts: '1234567891.000000' }
          ]
        };
      }
    };
  }
}

module.exports = MockSlackClient;