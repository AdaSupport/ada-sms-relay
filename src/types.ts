export type Env = {
  RELAY_KV: KVNamespace;
  ADA_API_BASE: string;
  VONAGE_API_BASE: string;
  CONVERSATION_TTL_SECONDS: string;
  ADA_API_KEY: string;
  ADA_WEBHOOK_SECRET?: string;
  VONAGE_API_KEY: string;
  VONAGE_API_SECRET: string;
  VONAGE_FROM_NUMBER: string;
  VONAGE_SIGNATURE_SECRET?: string;
  ENDED_REPLY_TEXT?: string;
};

export type AdaMessageContent =
  | { type: "text"; body: string }
  | { type: "link"; url: string; link_text?: string | null }
  | { type: "file"; url: string; mime_type: string; filename: string };

export type AdaConversationMessageEvent = {
  type: string;
  timestamp: string;
  data: {
    message_id: string;
    conversation_id: string;
    end_user_id: string;
    created_at: string;
    channel: { id: string; type: string; name: string; modality: string };
    author: { id: string | null; role: "end_user" | "ai_agent" | "human_agent" | string };
    content: AdaMessageContent;
    ai_agent_domain: string;
  };
};

export type LiveConversation = {
  conversation_id: string;
  end_user_id: string;
  channel_id: string;
  last_ada_message_id: string;
  updated_at: string;
};

export type VonageInbound = {
  from: string;
  to: string;
  channel: string;
  message_uuid: string;
  timestamp: string;
  message_type: string;
  text?: string;
};

export type VonageStatus = {
  message_uuid: string;
  to: string;
  from: string;
  timestamp: string;
  status: string;
  channel: string;
  client_ref?: string;
  error?: { type?: string; title?: string; detail?: string };
};
