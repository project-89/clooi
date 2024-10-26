import ChatClient from "./ChatClient.js";
import { fetchEventSource } from "@waylaidwanderer/fetch-event-source";
import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

const CLAUDE_MODEL_INFO = {
  default: {
    contextLength: 100000,
    vision: true,
    maxResponseTokens: 10000,
  },
  "claude-3-opus-20240229": {
    contextLength: 100000,
    vision: true,
    maxResponseTokens: 10000,
  },
  "claude-3-sonnet-20240229": {
    contextLength: 100000,
    vision: true,
    maxResponseTokens: 10000,
  },
  "claude-3-haiku-20240307": {
    contextLength: 100000,
    vision: true,
    maxResponseTokens: 10000,
  },
  "claude-3-sonnet-20240229-steering-preview": {
    contextLength: 100000,
    vision: true,
    maxResponseTokens: 10000,
  },
  "claude-3-5-sonnet-20240620": {
    contextLength: 100000,
    vision: true,
    maxResponseTokens: 10000,
  },
};

const CLAUDE_PARTICIPANTS = {
  bot: {
    display: "Claude",
    author: "assistant",
    defaultMessageType: "message",
  },
};

const CLAUDE_DEFAULT_MODEL_OPTIONS = {
  model: "claude-3-opus@20240229",
  contextLength: 100000,
  vision: true,
  maxResponseTokens: 10000,
};

export default class ClaudeClient extends ChatClient {
  constructor(options = {}) {
    options.cache.namespace = options.cache.namespace || "claude";
    super(options);
    this.projectId = process.env.GOOGLE_CLOUD_PROJECT || "argos-434718";
    this.location = options.location || "us-east5"; // Default to us-east5, can be overridden
    this.vertexCompletionsUrl = `https://${this.location}-aiplatform.googleapis.com/v1/projects/${this.projectId}/locations/${this.location}/publishers/anthropic/models/${CLAUDE_DEFAULT_MODEL_OPTIONS.model}:streamRawPredict`;

    this.modelOptions = CLAUDE_DEFAULT_MODEL_OPTIONS;
    this.participants = CLAUDE_PARTICIPANTS;
    this.modelInfo = CLAUDE_MODEL_INFO;
    this.n = 1;
    this.setOptions(options);
  }

  async getHeaders() {
    try {
      const { stdout, stderr } = await execAsync(
        "gcloud auth print-access-token"
      );
      if (stderr) {
        console.error(`Error getting access token: ${stderr}`);
        throw new Error(`Failed to get access token: ${stderr}`);
      }
      const accessToken = stdout.trim();
      if (!accessToken) {
        throw new Error("Access token is empty");
      }

      return {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json; charset=utf-8",
      };
    } catch (error) {
      console.error("Error in getHeaders:", error);
      throw error;
    }
  }

  async getCompletion(
    modelOptions,
    onProgress,
    abortController,
    debug = false
  ) {
    const headers = await this.getHeaders();

    // Format messages array, including system message if present
    const messages = modelOptions.messages || [];

    // Remove system from the body if it's null or undefined
    const requestBody = {
      anthropic_version: "vertex-2023-10-16",
      messages: messages,
      max_tokens: modelOptions.max_tokens,
      stream: modelOptions.stream,
    };

    // Only add system if it exists and format it properly
    if (modelOptions.system) {
      requestBody.system = modelOptions.system;
    }

    const body = JSON.stringify(requestBody);

    if (debug) {
      console.debug("Request body:", JSON.parse(body));
    }

    const opts = {
      method: "POST",
      headers,
      body,
    };

    const url = this.vertexCompletionsUrl;

    if (modelOptions.stream) {
      return new Promise(async (resolve, reject) => {
        abortController.signal.addEventListener("abort", () => {
          reject(new Error("Request aborted"));
        });

        try {
          let done = false;

          await fetchEventSource(url, {
            ...opts,
            signal: abortController.signal,
            async onopen(response) {
              if (response.status === 200) {
                return;
              }
              if (debug) {
                console.debug(response);
              }
              let error;
              try {
                const body = await response.text();
                error = new Error(
                  `Failed to send message. HTTP ${response.status} - ${body}`
                );
                error.status = response.status;
                error.json = JSON.parse(body);
              } catch {
                error =
                  error ||
                  new Error(`Failed to send message. HTTP ${response.status}`);
              }
              throw error;
            },
            onclose() {
              if (debug) {
                console.debug(
                  "Server closed the connection unexpectedly, returning..."
                );
              }
              if (!done) {
                onProgress("[DONE]");
                resolve();
              }
            },
            onerror(err) {
              if (debug) {
                console.debug(err);
              }
              throw err;
            },
            onmessage(message) {
              if (debug) {
                console.debug("Received message:", message);
              }
              if (!message.data || message.event === "ping") {
                return;
              }
              if (message.data === "[DONE]") {
                onProgress("[DONE]");
                resolve(message);
                done = true;
                return;
              }
              try {
                const parsedData = JSON.parse(message.data);
                if (debug) {
                  console.debug("Parsed data:", parsedData);
                }

                // Adjust this part based on the actual structure of the response
                if (parsedData.outputs && parsedData.outputs.length > 0) {
                  const content = parsedData.outputs[0].content;
                  if (content) {
                    onProgress(content);
                  } else {
                    // console.warn(
                    //   "Received message with unexpected structure:",
                    //   parsedData
                    // );
                  }
                } else {
                  if (parsedData.delta || parsedData.content_block) {
                    onProgress(parsedData);
                  } else {
                    // console.warn(
                    //   "Received message with unexpected structure:",
                    //   parsedData
                    // );
                  }
                }
              } catch (error) {
                console.error("Error parsing message data:", error);
                console.error("Raw message data:", message.data);
              }
            },
          });
        } catch (err) {
          reject(err);
        }
      });
    }

    const response = await fetch(url, {
      ...opts,
      signal: abortController.signal,
    });

    if (response.status !== 200) {
      const body = await response.text();
      const error = new Error(
        `Failed to send message. HTTP ${response.status} - ${body}`
      );
      error.status = response.status;
      try {
        error.json = JSON.parse(body);
      } catch {
        error.body = body;
      }
      throw error;
    }
    return response.json();
  }

  parseReplies(result, replies) {
    result.forEach((res, idx) => {
      replies[idx] = res.content[0].text;
    });
  }

  // buildApiParams(
  //   userMessage = null,
  //   previousMessages = [],
  //   systemMessage = null
  // ) {
  //   const { messages: history, system } = super.buildApiParams(
  //     userMessage,
  //     previousMessages,
  //     systemMessage
  //   );

  //   const mergedMessageHistory = [];

  //   let lastMessage = null;
  //   for (const message of history) {
  //     if (!message || !message.role) {
  //       console.warn("Invalid message in history:", message);
  //       continue;
  //     }

  //     if (lastMessage && lastMessage.role === message.role) {
  //       lastMessage.content[0].text += `\n${message.content}`;
  //     } else {
  //       lastMessage = {
  //         role: message.role,
  //         content: [{ type: "text", text: message.content }],
  //       };
  //       mergedMessageHistory.push(lastMessage);
  //     }
  //   }

  //   return {
  //     messages: mergedMessageHistory,
  //     stream: true,
  //   };
  // }
}
