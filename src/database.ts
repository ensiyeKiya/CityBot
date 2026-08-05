/**
 * PostgreSQL Database Connection for WoT Service
 * Direct database access without Python API layer
 */

import { Pool } from 'pg';

// Database connection configuration
const DB_CONFIG = {
  host: process.env.DB_HOST || '127.0.0.1',
  port: parseInt(process.env.DB_PORT || '5434'),
  database: process.env.DB_NAME || 'citybot_wot',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || undefined,
  // Pool keeps idle connections alive and reconnects automatically
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
};

// Connection pool — replaces the single Client so idle-timeout drops and
// concurrent queries are handled transparently.
let dbPool: Pool | null = null;

/**
 * Initialize database connection pool
 */
export async function initializeDatabase(): Promise<boolean> {
  try {
    if (dbPool) {
      await dbPool.end();
    }

    dbPool = new Pool(DB_CONFIG);

    // Verify connectivity with a quick probe
    const probe = await dbPool.connect();
    probe.release();

    console.log('✅ PostgreSQL pool connected successfully');

    // Create tables / run migrations
    await createUsersTable();
    await createSessionTable();
    if (await needsChatSchemaRebuild()) {
      await recreateChatDataTables();
    }
    await createChatHistoryTable();
    await createConversationTracesTable();
    await createUserFeedbackTable();

    return true;
  } catch (error) {
    console.error('❌ Failed to connect to PostgreSQL database:', error);
    return false;
  }
}

/**
 * Create users table for authentication
 */
async function createUsersTable(): Promise<void> {
  const client = getDatabaseClient();
  
  try {
    const query = `
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        username VARCHAR(100) UNIQUE NOT NULL,
        password VARCHAR(255) NOT NULL,
        email VARCHAR(255),
        full_name VARCHAR(255),
        role VARCHAR(50) DEFAULT 'user',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        last_login TIMESTAMP,
        is_active BOOLEAN DEFAULT true,
        CONSTRAINT username_length CHECK (char_length(username) >= 3)
      );
      
      CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
      CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
    `;
    
    await client.query(query);
    console.log('✅ Users table initialized');
  } catch (error) {
    console.error('❌ Failed to create users table:', error);
    throw error;
  }
}

/**
 * Get the connection pool instance
 */
export function getDatabaseClient(): Pool {
  if (!dbPool) {
    throw new Error('Database not initialized. Call initializeDatabase() first.');
  }
  return dbPool;
}

/**
 * Close all pool connections
 */
export async function closeDatabase(): Promise<void> {
  if (dbPool) {
    await dbPool.end();
    dbPool = null;
    console.log('✅ Database pool closed');
  }
}

/**
 * Session store table for express-session (connect-pg-simple schema).
 */
async function createSessionTable(): Promise<void> {
  const client = getDatabaseClient();

  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS "session" (
        "sid" varchar NOT NULL COLLATE "default" PRIMARY KEY,
        "sess" json NOT NULL,
        "expire" timestamp(6) NOT NULL
      );

      CREATE INDEX IF NOT EXISTS "IDX_session_expire" ON "session" ("expire");
    `);
    console.log('✅ Session table initialized');
  } catch (error) {
    console.error('❌ Failed to create session table:', error);
    throw error;
  }
}

/** Condition used when counting buildings for filter/action facts. */
export type BuildingFilterCondition = {
  filterType: string;
  filterValue: string;
};

function sqlColumnForFilterType(filterType: string): string | null {
  switch (filterType) {
    case 'class': return 'citygml_class_description';
    case 'walkability': return 'walk_access_index';
    case 'height': return 'citygml_measured_height';
    case 'energy':
    case 'energy LTB': return 'energy_ti_ltb';
    case 'energy UTB': return 'energy_ti_utb';
    case 'uhi4': return 't1600_max';
    case 'uhi9': return 't2100_max';
    case 'sunhours': return 'sunhrs_int_avg';
    default: return null;
  }
}

function defaultOperatorForFilterType(filterType: string): string {
  if (filterType === 'energy' || filterType === 'energy LTB') return '<=';
  return '>=';
}

function appendBuildingFilterCondition(
  where: string[],
  params: any[],
  filterType: string,
  filterValue: string
): void {
  const col = sqlColumnForFilterType(filterType);
  if (!col) throw new Error(`Unsupported filterType for counting: ${filterType}`);

  if (filterType === 'class') {
    params.push(filterValue);
    where.push(`${col} = $${params.length}`);
    return;
  }

  const v = String(filterValue).trim();
  const rangeMatch = v.match(/^(\d+\.?\d*)\s*-\s*(\d+\.?\d*)$/);
  if (rangeMatch) {
    params.push(parseFloat(rangeMatch[1]), parseFloat(rangeMatch[2]));
    where.push(`${col} >= $${params.length - 1} AND ${col} <= $${params.length}`);
    return;
  }

  const singleMatch = v.match(/^([><=!]+)?\s*(\d+\.?\d*)$/);
  if (!singleMatch) throw new Error(`Invalid numeric filter value for counting: ${filterValue}`);
  const op = singleMatch[1] || defaultOperatorForFilterType(filterType);
  if (!['>', '>=', '<', '<=', '=', '==', '!='].includes(op)) {
    throw new Error(`Invalid operator in filter value: ${op}`);
  }
  params.push(parseFloat(singleMatch[2]));
  where.push(`${col} ${op === '==' ? '=' : op} $${params.length}`);
}

/**
 * Count buildings matching ALL conditions (AND). Returns null if the query fails.
 * Used by domain actions to attach verified `facts` to their results.
 */
export async function countBuildingsMatching(conditions: BuildingFilterCondition[]): Promise<number | null> {
  if (!conditions.length) return 0;
  const client = getDatabaseClient();
  const where: string[] = [];
  const params: any[] = [];
  try {
    for (const c of conditions) {
      appendBuildingFilterCondition(where, params, c.filterType, c.filterValue);
    }
    const result = await client.query(
      `SELECT COUNT(*)::int AS count FROM buildings WHERE ${where.join(' AND ')}`,
      params
    );
    return result.rows[0]?.count ?? 0;
  } catch (error) {
    console.error('Error counting buildings for filter:', error, conditions);
    return null;
  }
}

/**
 * Get building statistics for visualization styles
 */
export async function getBuildingStatistics(): Promise<any> {
  const client = getDatabaseClient();
  
  try {
    const query = `
      SELECT 
        COUNT(*) as total_buildings,
        AVG(citygml_measured_height) as height_avg,
        MIN(citygml_measured_height) as height_min,
        MAX(citygml_measured_height) as height_max,
        AVG(walk_access_index) as walkability_avg,
        MIN(walk_access_index) as walkability_min,
        MAX(walk_access_index) as walkability_max,
        AVG(energy_ti_ltb) as energy_avg,
        MIN(energy_ti_ltb) as energy_min,
        MAX(energy_ti_ltb) as energy_max,
        AVG(energy_ti_utb) as energy_utb_avg,
        MIN(energy_ti_utb) as energy_utb_min,
        MAX(energy_ti_utb) as energy_utb_max
      FROM buildings 
      WHERE citygml_measured_height IS NOT NULL 
        AND walk_access_index IS NOT NULL 
        AND energy_ti_ltb IS NOT NULL
    `;
    
    const result = await client.query(query);
    return result.rows[0] || {};
  } catch (error) {
    console.error('Error getting building statistics:', error);
    return {};
  }
}

/**
 * Query buildings with various filters
 */
export async function queryBuildings(params: any): Promise<any> {
  const client = getDatabaseClient();
  
  try {
    let query = 'SELECT * FROM buildings WHERE 1=1';
    const queryParams: any[] = [];
    let paramCount = 1;
    
    // Build dynamic query based on parameters
    if (params.queryType === 'location' && params.latitude && params.longitude) {
      const radius = params.radius || 1000;
      query += ` AND ST_DWithin(
        ST_Point(longitude, latitude)::geography,
        ST_Point($${paramCount}, $${paramCount + 1})::geography,
        $${paramCount + 2}
      )`;
      queryParams.push(params.longitude, params.latitude, radius);
      paramCount += 3;
    }
    
    if (params.queryType === 'height') {
      if (params.minHeight) {
        query += ` AND citygml_measured_height >= $${paramCount}`;
        queryParams.push(params.minHeight);
        paramCount++;
      }
      if (params.maxHeight) {
        query += ` AND citygml_measured_height <= $${paramCount}`;
        queryParams.push(params.maxHeight);
        paramCount++;
      }
    }
    
    if (params.queryType === 'walkability') {
      if (params.minWalkability) {
        query += ` AND walk_access_index >= $${paramCount}`;
        queryParams.push(params.minWalkability);
        paramCount++;
      }
      if (params.maxWalkability) {
        query += ` AND walk_access_index <= $${paramCount}`;
        queryParams.push(params.maxWalkability);
        paramCount++;
      }
    }
    
    if (params.queryType === 'energy') {
      if (params.minEnergy) {
        query += ` AND energy_ti_ltb >= $${paramCount}`;
        queryParams.push(params.minEnergy);
        paramCount++;
      }
      if (params.maxEnergy) {
        query += ` AND energy_ti_ltb <= $${paramCount}`;
        queryParams.push(params.maxEnergy);
        paramCount++;
      }
    }
    
    if (params.functionDescription) {
      query += ` AND citygml_function_description ILIKE $${paramCount}`;
      queryParams.push(`%${params.functionDescription}%`);
      paramCount++;
    }
    
    if (params.classDescription) {
      query += ` AND citygml_class_description ILIKE $${paramCount}`;
      queryParams.push(`%${params.classDescription}%`);
      paramCount++;
    }
    
    if (params.searchTerm) {
      query += ` AND (
        cad_descr ILIKE $${paramCount} OR 
        osm_name ILIKE $${paramCount} OR 
        osm_name_en ILIKE $${paramCount} OR
        addr ILIKE $${paramCount}
      )`;
      queryParams.push(`%${params.searchTerm}%`);
      paramCount++;
    }
    
    // Add ordering and limit
    const limit = params.limit || 50;
    query += ` ORDER BY id LIMIT $${paramCount}`;
    queryParams.push(limit);
    
    const result = await client.query(query, queryParams);
    
    return {
      buildings: result.rows,
      count: result.rows.length,
      metadata: {
        queryType: params.queryType,
        limit: limit,
        timestamp: new Date().toISOString()
      }
    };
  } catch (error) {
    console.error('Error querying buildings:', error);
    throw error;
  }
}

/**
 * Analyze a specific building by GML ID
 */
export async function analyzeBuilding(gmlId: string): Promise<any> {
  const client = getDatabaseClient();
  
  try {
    const query = 'SELECT * FROM buildings WHERE gml_id = $1';
    const result = await client.query(query, [gmlId]);
    
    if (result.rows.length === 0) {
      return null;
    }
    
    const building = result.rows[0];
    
    // Generate analysis
    const analysis = {
      height_category: getHeightCategory(building.citygml_measured_height),
      walkability_category: getWalkabilityCategory(building.walk_access_index),
      energy_category: getEnergyCategory(building.energy_ti_ltb),
      function_type: building.citygml_function_description,
      class_type: building.citygml_class_description
    };
    
    return {
      building,
      analysis,
      insights: generateBuildingInsights(building, analysis)
    };
  } catch (error) {
    console.error('Error analyzing building:', error);
    throw error;
  }
}

/**
 * Find buildings near a location
 */
export async function findNearbyBuildings(latitude: number, longitude: number, radius: number = 500): Promise<any> {
  const client = getDatabaseClient();
  
  try {
    const query = `
      SELECT *, 
        ST_Distance(
          ST_Point(longitude, latitude)::geography,
          ST_Point($1, $2)::geography
        ) as distance
      FROM buildings 
      WHERE ST_DWithin(
        ST_Point(longitude, latitude)::geography,
        ST_Point($1, $2)::geography,
        $3
      )
      ORDER BY distance
      LIMIT 20
    `;
    
    const result = await client.query(query, [longitude, latitude, radius]);
    
    return {
      buildings: result.rows,
      count: result.rows.length,
      center: { latitude, longitude },
      radius: radius
    };
  } catch (error) {
    console.error('Error finding nearby buildings:', error);
    throw error;
  }
}

/**
 * Get building insights and statistics
 */
export async function getBuildingInsights(insightType: string = 'overview'): Promise<any> {
  const client = getDatabaseClient();
  
  try {
    let query: string;
    
    switch (insightType) {
      case 'height_distribution':
        query = `
          SELECT 
            CASE 
              WHEN citygml_measured_height < 10 THEN 'Low (<10m)'
              WHEN citygml_measured_height < 30 THEN 'Medium (10-30m)'
              WHEN citygml_measured_height < 60 THEN 'High (30-60m)'
              ELSE 'Very High (>60m)'
            END as height_category,
            COUNT(*) as count,
            AVG(citygml_measured_height) as avg_height
          FROM buildings 
          WHERE citygml_measured_height IS NOT NULL
          GROUP BY height_category
          ORDER BY avg_height
        `;
        break;
        
      case 'function_distribution':
        query = `
          SELECT 
            citygml_function_description as function_type,
            COUNT(*) as count,
            AVG(citygml_measured_height) as avg_height,
            AVG(walk_access_index) as avg_walkability
          FROM buildings 
          WHERE citygml_function_description IS NOT NULL
          GROUP BY citygml_function_description
          ORDER BY count DESC
          LIMIT 10
        `;
        break;
        
      case 'walkability_analysis':
        query = `
          SELECT 
            CASE 
              WHEN walk_access_index < 20 THEN 'Very Low (<20)'
              WHEN walk_access_index < 40 THEN 'Low (20-40)'
              WHEN walk_access_index < 60 THEN 'Medium (40-60)'
              WHEN walk_access_index < 80 THEN 'High (60-80)'
              ELSE 'Very High (>80)'
            END as walkability_category,
            COUNT(*) as count,
            AVG(walk_access_index) as avg_walkability
          FROM buildings 
          WHERE walk_access_index IS NOT NULL
          GROUP BY walkability_category
          ORDER BY avg_walkability
        `;
        break;
        
      case 'energy_analysis':
        query = `
          SELECT 
            CASE 
              WHEN energy_ti_ltb < 50 THEN 'Very Efficient (<50)'
              WHEN energy_ti_ltb < 100 THEN 'Efficient (50-100)'
              WHEN energy_ti_ltb < 150 THEN 'Moderate (100-150)'
              WHEN energy_ti_ltb < 200 THEN 'Inefficient (150-200)'
              ELSE 'Very Inefficient (>200)'
            END as energy_category,
            COUNT(*) as count,
            AVG(energy_ti_ltb) as avg_energy
          FROM buildings 
          WHERE energy_ti_ltb IS NOT NULL
          GROUP BY energy_category
          ORDER BY avg_energy
        `;
        break;
        
      default: // overview
        query = `
          SELECT 
            COUNT(*) as total_buildings,
            AVG(citygml_measured_height) as avg_height,
            MAX(citygml_measured_height) as max_height,
            MIN(citygml_measured_height) as min_height,
            AVG(walk_access_index) as avg_walkability,
            AVG(energy_ti_ltb) as avg_energy,
            COUNT(DISTINCT citygml_function_description) as unique_functions,
            COUNT(DISTINCT citygml_class_description) as unique_classes
          FROM buildings
        `;
    }
    
    const result = await client.query(query);
    
    return {
      insightType,
      data: result.rows,
      timestamp: new Date().toISOString()
    };
  } catch (error) {
    console.error('Error getting building insights:', error);
    throw error;
  }
}

// Helper functions
function getHeightCategory(height: number): string {
  if (!height) return 'Unknown';
  if (height < 10) return 'Low';
  if (height < 30) return 'Medium';
  if (height < 60) return 'High';
  return 'Very High';
}

function getWalkabilityCategory(walkability: number): string {
  if (!walkability) return 'Unknown';
  if (walkability < 20) return 'Very Low';
  if (walkability < 40) return 'Low';
  if (walkability < 60) return 'Medium';
  if (walkability < 80) return 'High';
  return 'Very High';
}

function getEnergyCategory(energy: number): string {
  if (!energy) return 'Unknown';
  if (energy < 50) return 'Very Efficient';
  if (energy < 100) return 'Efficient';
  if (energy < 150) return 'Moderate';
  if (energy < 200) return 'Inefficient';
  return 'Very Inefficient';
}

function generateBuildingInsights(building: any, analysis: any): string[] {
  const insights: string[] = [];
  
  if (building.citygml_measured_height) {
    insights.push(`This is a ${analysis.height_category.toLowerCase()} building at ${building.citygml_measured_height}m`);
  }
  
  if (building.walk_access_index) {
    insights.push(`Walkability score: ${building.walk_access_index}/100 (${analysis.walkability_category.toLowerCase()})`);
  }
  
  if (building.energy_ti_ltb) {
    insights.push(`Energy efficiency: ${building.energy_ti_ltb} kWh/m²/year (${analysis.energy_category.toLowerCase()})`);
  }
  
  if (building.citygml_function_description) {
    insights.push(`Building function: ${building.citygml_function_description}`);
  }
  
  return insights;
}

/**
 * Chat History Functions — all rows keyed by users.id (integer PK).
 */

async function needsChatSchemaRebuild(): Promise<boolean> {
  if (process.env.DB_REBUILD_CHAT === '1' || process.env.DB_REBUILD_CHAT === 'true') {
    return true;
  }
  const client = getDatabaseClient();
  const legacy = await client.query(`
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'chat_history'
      AND column_name = 'username'
    LIMIT 1
  `);
  return legacy.rows.length > 0;
}

async function recreateChatDataTables(): Promise<void> {
  const client = getDatabaseClient();
  console.log('🔄 Remaking chat_history, conversation_traces, user_feedback (user_id-only schema)...');
  await client.query('DROP TABLE IF EXISTS user_feedback CASCADE');
  await client.query('DROP TABLE IF EXISTS conversation_traces CASCADE');
  await client.query('DROP TABLE IF EXISTS chat_history CASCADE');
}

function assertValidUserId(userId: number, context: string): void {
  if (!Number.isInteger(userId) || userId <= 0) {
    throw new Error(`${context}: invalid userId ${String(userId)}`);
  }
}

async function createChatHistoryTable(): Promise<void> {
  const client = getDatabaseClient();

  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS chat_history (
        id         SERIAL PRIMARY KEY,
        user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        session_id VARCHAR(36) NOT NULL,
        role       VARCHAR(20) NOT NULL,
        content    TEXT NOT NULL,
        tools_used TEXT[] NOT NULL DEFAULT '{}',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    // Migration for databases created before the tools_used column existed
    await client.query(`ALTER TABLE chat_history ADD COLUMN IF NOT EXISTS tools_used TEXT[] NOT NULL DEFAULT '{}'`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_chat_history_user_id    ON chat_history(user_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_chat_history_session_id ON chat_history(session_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_chat_history_created_at ON chat_history(created_at)`);
    console.log('✅ Chat history table initialized');
  } catch (error) {
    console.error('❌ Failed to create chat_history table:', error);
    throw error;
  }
}

export async function saveChatMessage(userId: number, sessionId: string, role: string, content: string, toolsUsed: string[] = []): Promise<void> {
  const client = getDatabaseClient();

  try {
    assertValidUserId(userId, 'saveChatMessage');
    await client.query(
      'INSERT INTO chat_history (user_id, session_id, role, content, tools_used) VALUES ($1, $2, $3, $4, $5)',
      [userId, sessionId, role, content, toolsUsed]
    );
  } catch (error) {
    console.error('Error saving chat message to DB:', error);
    throw error;
  }
}

export async function getChatHistory(sessionId: string, limit: number = 20): Promise<{ role: string; content: string; toolsUsed: string[] }[]> {
  const client = getDatabaseClient();

  try {
    const result = await client.query(
      `SELECT role, content, tools_used
       FROM chat_history
       WHERE session_id = $1
       ORDER BY created_at ASC
       LIMIT $2`,
      [sessionId, limit]
    );
    return result.rows.map((row: any) => ({
      role: row.role,
      content: row.content,
      toolsUsed: row.tools_used ?? []
    }));
  } catch (error) {
    console.error('Error fetching chat history from DB:', error);
    return [];
  }
}

export async function clearUserChatHistory(userId: number): Promise<void> {
  const client = getDatabaseClient();

  try {
    await client.query('DELETE FROM chat_history WHERE user_id = $1', [userId]);
    console.log(`🧹 Cleared chat history for userId: ${userId}`);
  } catch (error) {
    console.error('Error clearing user chat history:', error);
  }
}

export async function clearAllChatHistories(): Promise<void> {
  const client = getDatabaseClient();

  try {
    await client.query('DELETE FROM chat_history');
    console.log('🧹 Cleared all chat histories from DB');
  } catch (error) {
    console.error('Error clearing all chat histories:', error);
  }
}

export interface ChatSession {
  session_id: string;
  user_id: number;
  message_count: number;
  started_at: Date;
  last_message_at: Date;
  preview: string;
}

/**
 * List all distinct sessions for a user, newest first.
 * Returns a preview from the first user message of each session.
 */
export async function getUserSessions(userId: number): Promise<ChatSession[]> {
  const client = getDatabaseClient();

  try {
    const result = await client.query(
      `SELECT
         session_id,
         user_id,
         COUNT(*) AS message_count,
         MIN(created_at) AS started_at,
         MAX(created_at) AS last_message_at,
         (
           SELECT content
           FROM chat_history h2
           WHERE h2.session_id = h.session_id
             AND h2.role = 'user'
           ORDER BY h2.created_at ASC
           LIMIT 1
         ) AS preview
     FROM chat_history h
     WHERE user_id = $1
       AND session_id IS NOT NULL
     GROUP BY session_id, user_id
     ORDER BY MAX(created_at) DESC`,
      [userId]
    );
    return result.rows;
  } catch (error) {
    console.error('Error fetching user sessions:', error);
    return [];
  }
}

/**
 * Get all messages for a specific session, in chronological order.
 * When userId is provided, only returns messages owned by that user.
 */
export async function getSessionMessages(
  sessionId: string,
  userId?: number
): Promise<{ role: string; content: string; created_at: Date }[]> {
  const client = getDatabaseClient();

  try {
    const result = userId != null
      ? await client.query(
          `SELECT role, content, created_at
           FROM chat_history
           WHERE session_id = $1 AND user_id = $2
           ORDER BY created_at ASC`,
          [sessionId, userId]
        )
      : await client.query(
          `SELECT role, content, created_at
           FROM chat_history
           WHERE session_id = $1
           ORDER BY created_at ASC`,
          [sessionId]
        );
    return result.rows;
  } catch (error) {
    console.error('Error fetching session messages:', error);
    return [];
  }
}

/**
 * User Management Functions
 */

export interface User {
  id?: number;
  username: string;
  password: string;
  email?: string;
  full_name?: string;
  role?: string;
  created_at?: Date;
  last_login?: Date;
  is_active?: boolean;
}

/**
 * Create a new user
 */
export async function createUser(username: string, hashedPassword: string, email?: string, fullName?: string): Promise<{ success: boolean; message: string; userId?: number }> {
  const client = getDatabaseClient();
  
  try {
    const query = `
      INSERT INTO users (username, password, email, full_name)
      VALUES ($1, $2, $3, $4)
      RETURNING id
    `;
    
    const result = await client.query(query, [username, hashedPassword, email || null, fullName || null]);
    
    console.log(`✅ User created: ${username} (ID: ${result.rows[0].id})`);
    return { 
      success: true, 
      message: 'User created successfully',
      userId: result.rows[0].id 
    };
  } catch (error: any) {
    if (error.code === '23505') { // Unique violation
      return { success: false, message: 'Username already exists' };
    }
    console.error('Error creating user:', error);
    return { success: false, message: 'Failed to create user' };
  }
}

/**
 * Get user by username
 */
export async function getUserByUsername(username: string): Promise<User | null> {
  const client = getDatabaseClient();
  
  try {
    const query = 'SELECT * FROM users WHERE username = $1 AND is_active = true';
    const result = await client.query(query, [username]);
    
    if (result.rows.length === 0) {
      return null;
    }
    
    return result.rows[0];
  } catch (error) {
    console.error('Error getting user:', error);
    return null;
  }
}

/**
 * Update user's last login timestamp
 */
export async function updateLastLogin(username: string): Promise<void> {
  const client = getDatabaseClient();
  
  try {
    const query = 'UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE username = $1';
    await client.query(query, [username]);
  } catch (error) {
    console.error('Error updating last login:', error);
  }
}

/**
 * Get all users (admin function)
 */
export async function getAllUsers(): Promise<User[]> {
  const client = getDatabaseClient();
  
  try {
    const query = 'SELECT id, username, email, full_name, role, created_at, last_login, is_active FROM users ORDER BY created_at DESC';
    const result = await client.query(query);
    return result.rows;
  } catch (error) {
    console.error('Error getting all users:', error);
    return [];
  }
}

/**
 * Delete user (admin function)
 */
export async function deleteUser(username: string): Promise<boolean> {
  const client = getDatabaseClient();
  
  try {
    const query = 'DELETE FROM users WHERE username = $1';
    const result = await client.query(query, [username]);
    
    if (result.rowCount && result.rowCount > 0) {
      console.log(`🗑️ User deleted: ${username}`);
      return true;
    }
    return false;
  } catch (error) {
    console.error('Error deleting user:', error);
    return false;
  }
}

/**
 * Check if any users exist in the database
 */
export async function hasUsers(): Promise<boolean> {
  const client = getDatabaseClient();
  
  try {
    const query = 'SELECT COUNT(*) as count FROM users';
    const result = await client.query(query);
    return parseInt(result.rows[0].count) > 0;
  } catch (error) {
    console.error('Error checking users:', error);
    return false;
  }
}

/**
 * Conversation Traces — full step-by-step reasoning stored for fine-tuning
 */

async function createConversationTracesTable(): Promise<void> {
  const client = getDatabaseClient();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS conversation_traces (
        id                 SERIAL PRIMARY KEY,
        request_id         VARCHAR(100) NOT NULL UNIQUE,
        session_id         VARCHAR(36)  NOT NULL,
        user_id            INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        user_message       TEXT         NOT NULL,
        final_response     TEXT,
        planning_turns     INTEGER      DEFAULT 0,
        tools_used         TEXT[]       DEFAULT '{}',
        full_trace         JSONB        NOT NULL,
        processing_time_ms INTEGER,
        model_name         VARCHAR(100),
        created_at         TIMESTAMPTZ  NOT NULL DEFAULT NOW()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_traces_session_id ON conversation_traces(session_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_traces_user_id    ON conversation_traces(user_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_traces_request_id ON conversation_traces(request_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_traces_created_at ON conversation_traces(created_at)`);
    console.log('✅ Conversation traces table initialized');
  } catch (error) {
    console.error('❌ Failed to create conversation_traces table:', error);
    throw error;
  }
}

export interface TraceStep {
  turn: number;
  /** Full conversation array sent to the model — the exact context it reasoned over */
  input_messages: Array<{ role: string; content: string | null; tool_calls?: any[]; tool_call_id?: string; name?: string }>;
  /** Model's visible reply (may include <think> tags or markdown reasoning) */
  assistant_content: string;
  /** Separate chain-of-thought field returned by reasoning models (e.g. Qwen-thinking) */
  reasoning_content: string | null;
  tool_calls: Array<{ id: string; name: string; args: any }>;
  tool_results: Array<{ tool_call_id: string; name: string; args: any; result: any; time_ms: number }>;
  tokens_used: number | null;
  time_ms: number;
}

export interface ConversationTrace {
  request_id: string;
  session_id: string;
  user_id: number;
  user_message: string;
  system_prompt: string;
  planning_steps: TraceStep[];
  final_response: string;
  /** Chain-of-thought from the final (non-tool) model call, if the model exposes it */
  final_reasoning: string | null;
  tools_used: string[];
  planning_turns: number;
  processing_time_ms: number;
  model_name: string;
}

export async function saveConversationTrace(trace: ConversationTrace): Promise<void> {
  const client = getDatabaseClient();
  try {
    assertValidUserId(trace.user_id, 'saveConversationTrace');
    await client.query(
      `INSERT INTO conversation_traces
         (request_id, session_id, user_id, user_message, final_response,
          planning_turns, tools_used, full_trace, processing_time_ms, model_name)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (request_id) DO NOTHING`,
      [
        trace.request_id,
        trace.session_id,
        trace.user_id,
        trace.user_message,
        trace.final_response,
        trace.planning_turns,
        trace.tools_used,
        JSON.stringify(trace),
        trace.processing_time_ms,
        trace.model_name,
      ]
    );
  } catch (error) {
    console.error('Error saving conversation trace:', error);
  }
}

/**
 * User Feedback
 */

async function createUserFeedbackTable(): Promise<void> {
  const client = getDatabaseClient();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS user_feedback (
        id            SERIAL PRIMARY KEY,
        request_id    VARCHAR(100) NOT NULL,
        session_id    VARCHAR(36)  NOT NULL,
        user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        rating        SMALLINT     CHECK (rating BETWEEN 1 AND 5),
        comment       TEXT,
        feedback_type VARCHAR(30)  DEFAULT 'response',
        created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_feedback_request_id ON user_feedback(request_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_feedback_user_id   ON user_feedback(user_id)`);
    console.log('✅ User feedback table initialized');
  } catch (error) {
    console.error('❌ Failed to create user_feedback table:', error);
    throw error;
  }
}

export async function saveUserFeedback(
  requestId: string,
  sessionId: string,
  userId: number,
  rating: number,
  comment: string,
  feedbackType: string = 'response'
): Promise<void> {
  const client = getDatabaseClient();
  try {
    assertValidUserId(userId, 'saveUserFeedback');
    await client.query(
      `INSERT INTO user_feedback (request_id, session_id, user_id, rating, comment, feedback_type)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [requestId, sessionId, userId, rating, comment || null, feedbackType]
    );
  } catch (error) {
    console.error('Error saving user feedback:', error);
    throw error;
  }
}
