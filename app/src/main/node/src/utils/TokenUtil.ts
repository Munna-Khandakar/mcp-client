import jwt from 'jsonwebtoken';

interface MembershipResponse {
    id: number;
    name: string;
    shortUrl: string;
    key: string;
    privateCommunity: boolean;
    admin: boolean;
    logoUrl: string;
    logoAltText: string;
    apiTokens: string[];
}

export class TokenUtil {
    static prepareBackendSystemKey(inputToken: string, ideascaleJwtSecret: string): string {
        try {
            // Decode the input JWT token without verification
            const decoded = jwt.decode(inputToken) as any;
            
            if (!decoded) {
                throw new Error('Invalid JWT token provided');
            }

            // Extract required fields from decoded token
            const workspaceId = decoded['workspace-id'];
            const memberId = decoded['member-id'];

            if (!workspaceId || !memberId) {
                throw new Error('Required fields (workspace-id, member-id) not found in token');
            }

            // Create new token with IdeaScale format as specified in CLAUDE.md
            const ideascaleToken = jwt.sign(
                {
                    workspaceRegistryId: workspaceId,
                    memberId: memberId,
                },
                ideascaleJwtSecret,
                {
                    algorithm: 'HS256',
                    issuer: 'ideascale',
                }
            );

            return ideascaleToken;
        } catch (error) {
            throw new Error(`Failed to prepare backend system key: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
    }

    static decodeToken(token: string): any {
        try {
            return jwt.decode(token);
        } catch (error) {
            throw new Error(`Failed to decode token: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
    }

    static verifyToken(token: string, secret: string): any {
        try {
            return jwt.verify(token, secret);
        } catch (error) {
            throw new Error(`Failed to verify token: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
    }

    /**
     * Fetches membership data from IdeaScale API and extracts the first API token
     * 
     * @param backendSystemKey - The backend system key token for authentication
     * @returns The first API token from the membership response
     */
    static async fetchApiToken(backendSystemKey: string): Promise<string> {
        try {
            const response = await fetch('https://ideas.ideascale.me/a/rest/backend/v1/memberships', {
                method: 'GET',
                headers: {
                    'backend_system_key': backendSystemKey,
                    'Content-Type': 'application/json'
                }
            });

            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }

            const memberships: MembershipResponse[] = await response.json();

            if (!memberships || memberships.length === 0) {
                throw new Error('No memberships found in response');
            }

            const firstMembership = memberships[0];
            
            if (!firstMembership.apiTokens || firstMembership.apiTokens.length === 0) {
                throw new Error('No API tokens found in first membership');
            }

            // Return the first API token from the first membership
            return firstMembership.apiTokens[0];
        } catch (error) {
            throw new Error(`Failed to fetch API token: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
    }

    /**
     * Complete workflow: decode JWT, create backend system key, and fetch API token
     * 
     * @param inputToken - Original JWT token
     * @param ideascaleJwtSecret - Secret for creating backend system key
     * @returns API token for MCP client
     */
    static async getApiTokenForMCP(inputToken: string, ideascaleJwtSecret: string): Promise<string> {
        try {
            // Step 1: Create backend system key
            const backendSystemKey = this.prepareBackendSystemKey(inputToken, ideascaleJwtSecret);
            
            // Step 2: Use backend system key to fetch API token
            const apiToken = await this.fetchApiToken(backendSystemKey);
            
            return apiToken;
        } catch (error) {
            throw new Error(`Failed to get API token for MCP: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
    }
}