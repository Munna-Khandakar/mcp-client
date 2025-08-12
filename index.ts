import {Anthropic} from "@anthropic-ai/sdk";
import {
    MessageParam,
    Tool,
} from "@anthropic-ai/sdk/resources/messages/messages.mjs";

import {Client} from "@modelcontextprotocol/sdk/client/index.js";
import {StreamableHTTPClientTransport} from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import express from "express";
import type {RequestHandler} from "express";
import cors from "cors";

// Configuration constants - define all values here
const ANTHROPIC_API_KEY = '';
const MCP_SERVER_URL = 'http://localhost:3078/mcp';
const SERVER_PORT = 3000;

interface SessionData {
    sessionId: string;
    mcpClient: MCPClient;
    createdAt: Date;
    lastActivity: Date;
}

// Global session storage
const sessions = new Map<string, SessionData>();

class MCPClient {
    private mcp: Client;
    private anthropic: Anthropic;
    private transport: StreamableHTTPClientTransport | null = null;
    public tools: Tool[] = [];
    private apiToken: string;
    private conversationHistory: MessageParam[] = [];
    public sessionId: string | null = null;

    constructor(apiToken: string) {
        this.apiToken = apiToken;
        // Initialize Anthropic client and MCP client
        this.anthropic = new Anthropic({
            apiKey: ANTHROPIC_API_KEY,
        });
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
            this.tools = toolsResult.tools.map((tool) => {
                return {
                    name: tool.name,
                    description: tool.description,
                    input_schema: tool.inputSchema,
                };
            });
            
            console.log(
                `Connected to MCP server with session ID: ${this.sessionId}`,
                "Tools:", this.tools.map(({name}) => name)
            );
            
            return this.sessionId || "no-session";
        } catch (e) {
            console.log("Failed to connect to MCP server: ", e);
            throw e;
        }
    }

    async processQuery(query: string) {
        /**
         * Process a query using Claude and available tools while maintaining conversation history
         *
         * @param query - The user's input query
         * @returns Processed response as a string
         */
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
            model: "claude-3-5-sonnet-20241022",
            max_tokens: 1000,
            messages,
            tools: this.tools,
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
                    model: "claude-3-5-sonnet-20241022",
                    max_tokens: 1000,
                    messages: [...this.conversationHistory],
                    tools: this.tools,
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

    getConversationHistory(): MessageParam[] {
        return [...this.conversationHistory];
    }
}

// Session management helper functions
async function createSession(apiToken: string): Promise<string> {
    const mcpClient = new MCPClient(apiToken);
    
    // Connect to MCP server and get the session ID from server
    const sessionId = await mcpClient.connectToServer();
    
    const sessionData: SessionData = {
        sessionId,
        mcpClient,
        createdAt: new Date(),
        lastActivity: new Date()
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
                health: 'GET /health',
                connect: 'POST /connect (requires Authorization header)',
                chat: 'POST /chat (requires sessionId)',
                disconnect: 'POST /disconnect (requires sessionId)',
                sessions: 'GET /sessions (list active sessions)'
            }
        });
    };
    app.get('/health', healthCheck);

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
            
            try {
                // Create session and connect to MCP server (session ID comes from server)
                const sessionId = await createSession(apiToken);
                const sessionData = getSession(sessionId);
                
                if (!sessionData) {
                    res.status(500).json({error: 'Failed to create session'});
                    return;
                }

                res.json({
                    sessionId,
                    message: 'Session created and connected to MCP server',
                    tools: sessionData.mcpClient.tools.map(t => t.name)
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
    app.post('/connect', connectHandler);

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
    app.post('/chat', chatHandler);

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
    app.post('/disconnect', disconnectHandler);

    // Sessions endpoint - list active sessions
    const sessionsHandler: RequestHandler = (_req, res) => {
        const sessionList = Array.from(sessions.values()).map(session => ({
            sessionId: session.sessionId,
            createdAt: session.createdAt,
            lastActivity: session.lastActivity,
            conversationLength: session.mcpClient.getConversationHistory().length,
            tools: session.mcpClient.tools.map(t => t.name)
        }));

        res.json({
            activeSessions: sessions.size,
            sessions: sessionList
        });
    };
    app.get('/sessions', sessionsHandler);

    app.listen(SERVER_PORT, () => {
        console.log(`\n🚀 MCP Client Server running on port ${SERVER_PORT}`);
        console.log(`📋 Health check: http://localhost:${SERVER_PORT}/health`);
        console.log(`🔗 Connect: POST http://localhost:${SERVER_PORT}/connect`);
        console.log(`💬 Chat: POST http://localhost:${SERVER_PORT}/chat`);
        console.log(`🔌 Disconnect: POST http://localhost:${SERVER_PORT}/disconnect`);
        console.log(`📊 Sessions: GET http://localhost:${SERVER_PORT}/sessions`);
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