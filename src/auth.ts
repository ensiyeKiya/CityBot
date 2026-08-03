import bcrypt from 'bcryptjs';
import { 
  createUser as dbCreateUser, 
  getUserByUsername, 
  updateLastLogin,
  deleteUser as dbDeleteUser,
  hasUsers,
  User 
} from './database';

/**
 * Create a new user
 * @param email - Email address (used as username)
 * @param password - Plain text password (will be hashed)
 * @param name - User's name
 */
export async function createUser(email: string, password: string, name: string): Promise<{ success: boolean; message: string }> {
  // Validate email and password
  if (!email || email.length < 3) {
    return { success: false, message: 'Email must be at least 3 characters long' };
  }
  
  if (!password || password.length < 6) {
    return { success: false, message: 'Password must be at least 6 characters long' };
  }

  try {
    // Hash password
    const hashedPassword = await bcrypt.hash(password, 10);

    // Create user in database with email, password, and full name
    const result = await dbCreateUser(email, hashedPassword, email, name);
    
    return result;
  } catch (error) {
    console.error('Error creating user:', error);
    return { success: false, message: 'Failed to create user' };
  }
}

/**
 * Authenticate user
 */
export async function authenticateUser(email: string, password: string): Promise<{ success: boolean; message: string; user?: User }> {
  try {
    // Get user from database (email is stored in username field)
    const user = await getUserByUsername(email);

    if (!user) {
      return { success: false, message: 'Invalid email or password' };
    }

    // Verify password
    const isValid = await bcrypt.compare(password, user.password);
    
    if (!isValid) {
      return { success: false, message: 'Invalid email or password' };
    }

    // Update last login (email is stored as username)
    await updateLastLogin(email);

    console.log(`✅ User authenticated: ${email}`);
    return { success: true, message: 'Authentication successful', user };
  } catch (error) {
    console.error('Error authenticating user:', error);
    return { success: false, message: 'Authentication failed' };
  }
}

/**
 * Get user by username
 */
export async function getUser(email: string): Promise<User | null> {
  try {
    return await getUserByUsername(email);
  } catch (error) {
    console.error('Error getting user:', error);
    return null;
  }
}

/**
 * Delete user (admin function)
 */
export async function deleteUser(email: string): Promise<boolean> {
  try {
    return await dbDeleteUser(email); // email is stored as username
  } catch (error) {
    console.error('Error deleting user:', error);
    return false;
  }
}

/**
 * Initialize default admin user if no users exist
 */
export async function initializeDefaultUser(): Promise<void> {
  try {
    const usersExist = await hasUsers();
    
    if (!usersExist) {
      const defaultEmail = process.env.DEFAULT_ADMIN_EMAIL;
      const defaultPassword = process.env.DEFAULT_ADMIN_PASSWORD;

      const defaultName = process.env.DEFAULT_ADMIN_NAME;
      const result = await createUser(defaultEmail || '', defaultPassword || '', defaultName || 'Admin');
      
      if (result.success) {
        console.log(`🔐 Default admin user created: ${defaultName}`);
        console.log(`⚠️  Please change the default password after first login!`);
      } else {
        console.error(`❌ Failed to create default user: ${result.message}`);
      }
    }
  } catch (error) {
    console.error('Error initializing default user:', error);
  }
}
