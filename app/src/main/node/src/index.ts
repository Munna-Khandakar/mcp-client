import {Anthropic} from "@anthropic-ai/sdk";
import {
    MessageParam,
    Tool,
} from "@anthropic-ai/sdk/resources/messages/messages.mjs";

import OpenAI from "openai";
import { Ollama } from "ollama";

import {Client} from "@modelcontextprotocol/sdk/client/index.js";
import {StreamableHTTPClientTransport} from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import express, {Router} from "express";
import type {RequestHandler} from "express";
import cors from "cors";

// Configuration constants - define all values here
const ANTHROPIC_API_KEY = '';
const OPENAI_API_KEY = '';
const OLLAMA_BASE_URL = 'http://localhost:11434'; // Default Ollama endpoint
const MCP_SERVER_URL = 'http://localhost:3078/mcp';
const SERVER_PORT = 3077;
const ANTHROPIC_MODEL = 'claude-3-5-haiku-latest';
const OPENAI_MODEL = 'gpt-4o-mini';
const OLLAMA_MODEL = 'llama3.2:1b'; // Default Ollama model

type ModelProvider = 'anthropic' | 'openai' | 'ollama';

interface SessionData {
    sessionId: string;
    mcpClient: MCPClient;
    createdAt: Date;
    lastActivity: Date;
    provider: ModelProvider;
}

// Global session storage
const sessions = new Map<string, SessionData>();

class MCPClient {
    private mcp: Client;
    private anthropic: Anthropic | null = null;
    private openai: OpenAI | null = null;
    private ollama: Ollama | null = null;
    private transport: StreamableHTTPClientTransport | null = null;
    public tools: Tool[] = [];
    private apiToken: string;
    private conversationHistory: any[] = [];
    public sessionId: string | null = null;
    private provider: ModelProvider;

    constructor(apiToken: string, provider: ModelProvider = 'anthropic') {
        this.apiToken = apiToken;
        this.provider = provider;
        
        // Initialize the appropriate client and MCP client
        if (provider === 'anthropic') {
            this.anthropic = new Anthropic({
                apiKey: ANTHROPIC_API_KEY,
            });
        } else if (provider === 'openai') {
            this.openai = new OpenAI({
                apiKey: OPENAI_API_KEY,
            });
        } else if (provider === 'ollama') {
            this.ollama = new Ollama({
                host: OLLAMA_BASE_URL,
            });
        }
        
        this.mcp = new Client({name: "mcp-client-http", version: "1.0.0"});
    }

    async connectToServer(): Promise<string> {
        /**
         * Connect to MCP server using StreamableHTTPClientTransport with API token
         * Returns the session ID provided by the MCP server
         */
        try {
            const url = new URL(MCP_SERVER_URL);
            url.searchParams.set('api_token', this.apiToken);
            this.transport = new StreamableHTTPClientTransport(url);

            // Connect to server
            await this.mcp.connect(this.transport);
            
            // Get session ID from transport's Mcp-Session-Id header after successful connection
            // The StreamableHTTPClientTransport should extract this from the server's response header
            this.sessionId = (this.transport as any)?.sessionId || null;

            if (!this.sessionId) {
                console.warn("MCP server did not provide Mcp-Session-Id header during initialization");
                // According to MCP spec, session ID is optional - server may not use sessions
                this.sessionId = null;
            }

            // List available tools
            const toolsResult = await this.mcp.listTools();
            
            // Convert MCP tools to format compatible with Anthropic, OpenAI, and Ollama
            if (this.provider === 'anthropic') {
                this.tools = toolsResult.tools.map((tool) => {
                    return {
                        name: tool.name,
                        description: tool.description,
                        input_schema: tool.inputSchema,
                    };
                });
            } else if (this.provider === 'openai' || this.provider === 'ollama') {
                // OpenAI and Ollama both use the same tool format
                this.tools = toolsResult.tools.map((tool) => {
                    return {
                        type: "function",
                        function: {
                            name: tool.name,
                            description: tool.description,
                            parameters: tool.inputSchema,
                        }
                    };
                }) as any[];
            }
            
            console.log(
                `Connected to MCP server with session ID: ${this.sessionId}`,
                "Tools:", this.tools.map((tool: any) => 
                    this.provider === 'anthropic' ? tool.name : tool.function.name
                )
            );

            return this.sessionId || "no-session";
        } catch (e) {
            console.log("Failed to connect to MCP server: ", e);
            throw e;
        }
    }

    async processQuery(query: string) {
        /**
         * Process a query using the selected model provider and available tools while maintaining conversation history
         *
         * @param query - The user's input query
         * @returns Processed response as a string
         */
        if (this.provider === 'anthropic') {
            return this.processQueryWithAnthropic(query);
        } else if (this.provider === 'openai') {
            return this.processQueryWithOpenAI(query);
        } else if (this.provider === 'ollama') {
            return this.processQueryWithOllama(query);
        } else {
            throw new Error(`Unsupported provider: ${this.provider}`);
        }
    }

    private async processQueryWithAnthropic(query: string): Promise<string> {
        if (!this.anthropic) {
            throw new Error('Anthropic client not initialized');
        }

        // Add user message to conversation history
        const userMessage: MessageParam = {
            role: "user",
            content: query,
        };
        this.conversationHistory.push(userMessage);

        // Use full conversation history for context
        const messages: MessageParam[] = [...this.conversationHistory];

        // Initial Claude API call
        const response = await this.anthropic.messages.create({
            model: ANTHROPIC_MODEL,
            max_tokens: 1000,
            messages,
            tools: this.tools as Tool[],
        });

        // Process response and handle tool calls
        let assistantResponse = "";
        
        // First, add the assistant's response (including any tool_use) to conversation history
        this.conversationHistory.push({
            role: "assistant",
            content: response.content
        });
        
        for (const content of response.content) {
            if (content.type === "text") {
                assistantResponse += content.text;
            } else if (content.type === "tool_use") {
                
                // Execute tool call
                const toolName = content.name;
                const toolArgs = content.input as { [x: string]: unknown } | undefined;

                const result = await this.mcp.callTool({
                    name: toolName,
                    arguments: toolArgs,
                });

                // Add tool result to conversation history (user role with tool_result)
                const toolResultMessage: MessageParam = {
                    role: "user", 
                    content: [
                        {
                            type: "tool_result",
                            tool_use_id: content.id,
                            content: result.content as string
                        }
                    ]
                };
                this.conversationHistory.push(toolResultMessage);

                // Get next response from Claude with tool results
                const followupResponse = await this.anthropic.messages.create({
                    model: ANTHROPIC_MODEL,
                    max_tokens: 1000,
                    messages: [...this.conversationHistory],
                    tools: this.tools as Tool[],
                });

                // Process followup response
                for (const followupContent of followupResponse.content) {
                    if (followupContent.type === "text") {
                        assistantResponse += followupContent.text;
                    }
                }
                
                // Add final assistant response to conversation history
                this.conversationHistory.push({
                    role: "assistant",
                    content: followupResponse.content
                });
            }
        }

        return assistantResponse;
    }

    private async processQueryWithOpenAI(query: string): Promise<string> {
        if (!this.openai) {
            throw new Error('OpenAI client not initialized');
        }

        // Add user message to conversation history
        const userMessage = {
            role: "user" as const,
            content: query,
        };
        this.conversationHistory.push(userMessage);

        // Initial OpenAI API call
        const response = await this.openai.chat.completions.create({
            model: OPENAI_MODEL,
            max_tokens: 1000,
            messages: [...this.conversationHistory],
            tools: this.tools.length > 0 ? this.tools as any[] : undefined,
        });

        const message = response.choices[0].message;
        let assistantResponse = message.content || "";

        // Add assistant's response to conversation history
        this.conversationHistory.push({
            role: "assistant",
            content: message.content,
            tool_calls: message.tool_calls
        });

        // Handle tool calls if any
        if (message.tool_calls && message.tool_calls.length > 0) {
            for (const toolCall of message.tool_calls) {
                // Execute tool call
                const toolName = toolCall.function.name;
                const toolArgs = JSON.parse(toolCall.function.arguments);

                const result = await this.mcp.callTool({
                    name: toolName,
                    arguments: toolArgs,
                });

                // Add tool result to conversation history
                this.conversationHistory.push({
                    role: "tool",
                    content: result.content as string,
                    tool_call_id: toolCall.id
                });
            }

            // Get next response from OpenAI with tool results
            const followupResponse = await this.openai.chat.completions.create({
                model: OPENAI_MODEL,
                max_tokens: 1000,
                messages: [...this.conversationHistory],
                tools: this.tools.length > 0 ? this.tools as any[] : undefined,
            });

            const followupMessage = followupResponse.choices[0].message;
            assistantResponse = followupMessage.content || "";

            // Add final assistant response to conversation history
            this.conversationHistory.push({
                role: "assistant",
                content: followupMessage.content,
                tool_calls: followupMessage.tool_calls
            });
        }

        return assistantResponse;
    }

    private async processQueryWithOllama(query: string): Promise<string> {
        if (!this.ollama) {
            throw new Error('Ollama client not initialized');
        }

        // Add user message to conversation history
        const userMessage = {
            role: "user" as const,
            content: query,
        };
        this.conversationHistory.push(userMessage);

        // Initial Ollama API call
        const response = await this.ollama.chat({
            model: OLLAMA_MODEL,
            messages: [...this.conversationHistory],
            tools: this.tools.length > 0 ? this.tools as any[] : undefined,
        });

        const message = response.message;
        let assistantResponse = message.content || "";

        // Add assistant's response to conversation history
        this.conversationHistory.push({
            role: "assistant",
            content: message.content,
            tool_calls: message.tool_calls
        });

        // Handle tool calls if any
        if (message.tool_calls && message.tool_calls.length > 0) {
            for (const toolCall of message.tool_calls) {
                // Execute tool call
                const toolName = toolCall.function.name;
                const toolArgs = typeof toolCall.function.arguments === 'string' ? 
                    JSON.parse(toolCall.function.arguments) : toolCall.function.arguments;

                const result = await this.mcp.callTool({
                    name: toolName,
                    arguments: toolArgs,
                });

                // Add tool result to conversation history
                this.conversationHistory.push({
                    role: "tool",
                    content: result.content as string,
                    tool_call_id: (toolCall as any).id || toolCall.function.name
                });
            }

            // Get next response from Ollama with tool results
            const followupResponse = await this.ollama.chat({
                model: OLLAMA_MODEL,
                messages: [...this.conversationHistory],
                tools: this.tools.length > 0 ? this.tools as any[] : undefined,
            });

            const followupMessage = followupResponse.message;
            assistantResponse = followupMessage.content || "";

            // Add final assistant response to conversation history
            this.conversationHistory.push({
                role: "assistant",
                content: followupMessage.content,
                tool_calls: followupMessage.tool_calls
            });
        }

        return assistantResponse;
    }

    async cleanup() {
        /**
         * Clean up resources and optionally send DELETE to terminate session
         */
        await this.mcp.close();
    }

    async terminateSession(): Promise<void> {
        /**
         * Terminate session by sending HTTP DELETE to MCP endpoint with Mcp-Session-Id header
         * As per MCP spec: "Clients that no longer need a particular session SHOULD send an HTTP DELETE"
         */
        if (this.sessionId && this.transport) {
            try {
                const response = await fetch(MCP_SERVER_URL, {
                    method: 'DELETE',
                    headers: {
                        'Mcp-Session-Id': this.sessionId,
                        'Authorization': `Bearer ${this.apiToken}`,
                    },
                });

                if (response.status === 405) {
                    console.log('MCP server does not allow client-initiated session termination (405 Method Not Allowed)');
                } else if (response.ok) {
                    console.log(`Session ${this.sessionId} terminated successfully`);
                } else {
                    console.warn(`Failed to terminate session ${this.sessionId}: ${response.status} ${response.statusText}`);
                }
            } catch (error) {
                console.error(`Error terminating session ${this.sessionId}:`, error);
            }
        }
        
        await this.cleanup();
    }

    getConversationHistory(): any[] {
        return [...this.conversationHistory];
    }

    getProvider(): ModelProvider {
        return this.provider;
    }
}

// Session management helper functions
async function createSession(apiToken: string, provider: ModelProvider = 'anthropic'): Promise<string> {
    const mcpClient = new MCPClient(apiToken, provider);
    
    // Connect to MCP server and get the session ID from server
    const sessionId = await mcpClient.connectToServer();
    
    const sessionData: SessionData = {
        sessionId,
        mcpClient,
        createdAt: new Date(),
        lastActivity: new Date(),
        provider
    };
    
    sessions.set(sessionId, sessionData);
    return sessionId;
}

function getSession(sessionId: string): SessionData | null {
    const session = sessions.get(sessionId);
    if (session) {
        session.lastActivity = new Date();
        return session;
    }
    return null;
}

async function removeSession(sessionId: string): Promise<void> {
    const session = sessions.get(sessionId);
    if (session) {
        // Properly terminate session with MCP server via DELETE request
        await session.mcpClient.terminateSession().catch(console.error);
        sessions.delete(sessionId);
    }
}

// Session cleanup is now handled by explicit DELETE requests only
// As per MCP spec: sessions are terminated by client DELETE requests or server 404 responses

async function main() {
    const app = express();
    const router = Router();

    // Middleware
    app.use(cors());
    app.use(express.json());

    // Health check endpoint
    const healthCheck: RequestHandler = (_req, res) => {
        res.json({
            status: 'ok',
            message: 'MCP client server is running',
            activeSessions: sessions.size,
            endpoints: {
                health: 'GET /mcp-client/health',
                connect: 'POST /mcp-client/connect (requires Authorization header, optional provider: "anthropic", "openai", or "ollama")',
                chat: 'POST /mcp-client/chat (requires sessionId)',
                disconnect: 'POST /mcp-client/disconnect (requires sessionId)',
                sessions: 'GET /mcp-client/sessions (list active sessions)'
            },
            supportedProviders: ['anthropic', 'openai', 'ollama'],
            defaultProvider: 'anthropic'
        });
    };
    router.get('/health', healthCheck);

    // Connect endpoint - creates a new persistent session
    const connectHandler: RequestHandler = async (req, res) => {
        try {
            // Get API token from Authorization header
            const authHeader = req.headers.authorization;
            if (!authHeader || !authHeader.startsWith('Bearer ')) {
                res.status(401).json({error: 'Authorization header with Bearer token is required'});
                return;
            }

            const apiToken = authHeader.substring(7); // Remove 'Bearer ' prefix
            
            // Get provider from request body (default to 'anthropic')
            const { provider } = req.body || {};
            const modelProvider: ModelProvider = 
                provider === 'openai' ? 'openai' : 
                provider === 'ollama' ? 'ollama' : 'anthropic';

            try {
                // Create session and connect to MCP server (session ID comes from server)
                const sessionId = await createSession(apiToken, modelProvider);
                const sessionData = getSession(sessionId);

                if (!sessionData) {
                    res.status(500).json({error: 'Failed to create session'});
                    return;
                }

                res.json({
                    sessionId,
                    message: `Session created and connected to MCP server using ${modelProvider}`,
                    provider: modelProvider,
                    tools: sessionData.mcpClient.tools.map((t: any) => 
                        modelProvider === 'anthropic' ? t.name : t.function.name
                    )
                });
            } catch (error) {
                console.error('Failed to connect to MCP server:', error);
                res.status(500).json({error: 'Failed to connect to MCP server'});
            }
        } catch (error) {
            console.error('Error creating session:', error);
            res.status(500).json({error: 'Failed to create session'});
        }
    };
    router.post('/connect', connectHandler);

    // Chat endpoint - uses existing session
    const chatHandler: RequestHandler = async (req, res) => {
        try {
            const {query, sessionId} = req.body;
            if (!query) {
                res.status(400).json({error: 'Query is required'});
                return;
            }
            if (!sessionId) {
                res.status(400).json({error: 'SessionId is required. Please connect first using /connect endpoint'});
                return;
            }

            // Get session
            const sessionData = getSession(sessionId);
            if (!sessionData) {
                res.status(404).json({error: 'Session not found or expired. Please connect again using /connect endpoint'});
                return;
            }

            try {
                const response = await sessionData.mcpClient.processQuery(query);
                res.json({
                    response,
                    sessionId,
                    conversationLength: sessionData.mcpClient.getConversationHistory().length
                });
            } catch (error) {
                // Check if this is a 404 error indicating session termination by server
                if ((error as any)?.status === 404 || (error as any)?.code === 404) {
                    console.log(`Session ${sessionId} terminated by MCP server (404)`);
                    await removeSession(sessionId);
                    res.status(404).json({
                        error: 'Session terminated by server. Please connect again.',
                        requiresReconnect: true
                    });
                } else {
                    console.error(`Error processing query for session ${sessionId}:`, error);
                    res.status(500).json({error: 'Failed to process query'});
                }
            }
        } catch (error) {
            console.error('Error in chat handler:', error);
            res.status(500).json({error: 'Failed to process chat request'});
        }
    };
    router.post('/chat', chatHandler);

    // Disconnect endpoint - removes session
    const disconnectHandler: RequestHandler = async (req, res) => {
        try {
            const {sessionId} = req.body;
            if (!sessionId) {
                res.status(400).json({error: 'SessionId is required'});
                return;
            }

            const session = getSession(sessionId);
            if (!session) {
                res.status(404).json({error: 'Session not found'});
                return;
            }

            await removeSession(sessionId);
            res.json({
                message: 'Session disconnected successfully',
                sessionId
            });
        } catch (error) {
            console.error('Error disconnecting session:', error);
            res.status(500).json({error: 'Failed to disconnect session'});
        }
    };
    router.post('/disconnect', disconnectHandler);

    // Sessions endpoint - list active sessions
    const sessionsHandler: RequestHandler = (_req, res) => {
        const sessionList = Array.from(sessions.values()).map(session => ({
            sessionId: session.sessionId,
            createdAt: session.createdAt,
            lastActivity: session.lastActivity,
            provider: session.provider,
            conversationLength: session.mcpClient.getConversationHistory().length,
            tools: session.mcpClient.tools.map((t: any) => 
                session.provider === 'anthropic' ? t.name : t.function.name
            )
        }));

        res.json({
            activeSessions: sessions.size,
            sessions: sessionList
        });
    };
    router.get('/sessions', sessionsHandler);

    // Mount router with /mcp-client prefix
    app.use('/mcp-client', router);

    app.listen(SERVER_PORT, () => {
        console.log(`\n🚀 MCP Client Server running on port ${SERVER_PORT}`);
        console.log(`📋 Health check: http://localhost:${SERVER_PORT}/mcp-client/health`);
        console.log(`🔗 Connect: POST http://localhost:${SERVER_PORT}/mcp-client/connect`);
        console.log(`💬 Chat: POST http://localhost:${SERVER_PORT}/mcp-client/chat`);
        console.log(`🔌 Disconnect: POST http://localhost:${SERVER_PORT}/mcp-client/disconnect`);
        console.log(`📊 Sessions: GET http://localhost:${SERVER_PORT}/mcp-client/sessions`);
        console.log(`🔧 MCP server URL: ${MCP_SERVER_URL}`);
        console.log(`✨ Server ready with persistent session management and conversation context!`);
    });

    // Handle graceful shutdown
    process.on('SIGTERM', () => {
        console.log('SIGTERM received. Shutting down gracefully...');
        process.exit(0);
    });
}

main().catch(console.error);