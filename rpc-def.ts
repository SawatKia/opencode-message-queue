export const MQ_RPC_ID = "message-queue";
export const mqRpc = {
  id: MQ_RPC_ID,
  methods: {
    getState: {
      input: { type: "object", properties: { sessionID: { type: "string" } }, required: ["sessionID"], additionalProperties: false },
      output: { type: "object" },
    },
    setMode: {
      input: { type: "object", properties: { sessionID: { type: "string" }, mode: { type: "string", enum: ["queue", "steer"] } }, required: ["sessionID", "mode"], additionalProperties: false },
      output: { type: "object" },
    },
  },
  events: {},
} as const;
