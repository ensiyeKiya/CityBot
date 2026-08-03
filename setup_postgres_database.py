#!/usr/bin/env python3
"""
PostgreSQL Database Setup for CityBot WoT Project
Creates proper database tables and imports CSV data
"""

import os
import pandas as pd
import psycopg2
from psycopg2.extras import RealDictCursor
import json
from datetime import datetime
from pathlib import Path
from typing import Dict, List, Any, Optional
import logging

# Setup logging
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

class PostgreSQLDatabaseSetup:
    def __init__(self, 
                 host: str = "127.0.0.1",
                 port: int = 5434,
                 database: str = "citybot_wot",
                 user: str = "postgres",
                 password: Optional[str] = None):
        """
        Initialize PostgreSQL database setup
        
        Args:
            host: PostgreSQL host
            port: PostgreSQL port
            database: Database name
            user: Database user
            password: Database password (if required)
        """
        self.host = host
        self.port = port
        self.database = database
        self.user = user
        self.password = password
        
        # Connection parameters
        self.conn_params = {
            'host': host,
            'port': port,
            'database': database,
            'user': user
        }
        if password:
            self.conn_params['password'] = password
    
    def drop_database(self) -> bool:
        """Drop the database if it exists"""
        try:
            # Connect to postgres database to drop our database
            postgres_params = self.conn_params.copy()
            postgres_params['database'] = 'postgres'
            
            conn = psycopg2.connect(**postgres_params)
            conn.autocommit = True
            
            try:
                with conn.cursor() as cur:
                    # Check if database exists
                    cur.execute("SELECT 1 FROM pg_database WHERE datname = %s", (self.database,))
                    exists = cur.fetchone()
                    
                    if exists:
                        # Terminate any existing connections to the database
                        cur.execute("""
                            SELECT pg_terminate_backend(pid)
                            FROM pg_stat_activity
                            WHERE datname = %s AND pid <> pg_backend_pid()
                        """, (self.database,))
                        
                        # Drop the database
                        cur.execute(f'DROP DATABASE "{self.database}"')
                        logger.info(f"🗑️ Dropped existing database: {self.database}")
                    else:
                        logger.info(f"ℹ️ Database does not exist: {self.database}")
                    return True
            finally:
                conn.close()
                
        except Exception as e:
            logger.error(f"❌ Error dropping database: {e}")
            return False

    def create_database(self) -> bool:
        """Create the database if it doesn't exist"""
        try:
            # Connect to postgres database to create our database
            postgres_params = self.conn_params.copy()
            postgres_params['database'] = 'postgres'
            
            conn = psycopg2.connect(**postgres_params)
            conn.autocommit = True
            
            try:
                with conn.cursor() as cur:
                    # Check if database exists
                    cur.execute("SELECT 1 FROM pg_database WHERE datname = %s", (self.database,))
                    exists = cur.fetchone()
                    
                    if not exists:
                        cur.execute(f'CREATE DATABASE "{self.database}"')
                        logger.info(f"✅ Created database: {self.database}")
                    else:
                        logger.info(f"✅ Database already exists: {self.database}")
                    return True
            finally:
                conn.close()
                
        except Exception as e:
            logger.error(f"❌ Error creating database: {e}")
            return False

    def test_connection(self) -> bool:
        """Test PostgreSQL connection"""
        try:
            with psycopg2.connect(**self.conn_params) as conn:
                with conn.cursor() as cur:
                    cur.execute("SELECT version();")
                    version = cur.fetchone()
                    logger.info(f"✅ Connected to PostgreSQL: {version[0]}")
                    return True
        except Exception as e:
            logger.error(f"❌ Connection failed: {e}")
            return False
    
    def create_database_schema(self) -> bool:
        """Create database schema with buildings table only"""
        try:
            with psycopg2.connect(**self.conn_params) as conn:
                with conn.cursor() as cur:
                    logger.info("🏗️ Creating database schema for buildings data...")
                    
                    # Create buildings table
                    buildings_sql = """
                    CREATE TABLE IF NOT EXISTS buildings (
                        id SERIAL PRIMARY KEY,
                        citygml_lod_name VARCHAR(50),
                        citygml_feature_role VARCHAR(50),
                        gml_id VARCHAR(100) UNIQUE,
                        citygml_storeys_above_ground INTEGER,
                        citygml_measured_height DECIMAL(10,2),
                        geom_src VARCHAR(50),
                        dtm2m_median DECIMAL(10,2),
                        citygml_class INTEGER,
                        citygml_class_description TEXT,
                        citygml_function INTEGER,
                        citygml_function_description TEXT,
                        citygml_creation_date DATE,
                        citygml_measured_height_units VARCHAR(10),
                        dtm2m_min DECIMAL(10,2),
                        cad_code INTEGER,
                        cad_descr TEXT,
                        energy_ti_ltb DECIMAL(10,2),
                        energy_ti_utb DECIMAL(10,2),
                        walk_access_index DECIMAL(10,2),
                        walk_index DECIMAL(10,2),
                        walk_cu_raw DECIMAL(10,2),
                        walk_cu_capped DECIMAL(10,2),
                        osm_name VARCHAR(255),
                        osm_name_en VARCHAR(255),
                        osm_type VARCHAR(50),
                        osm_id BIGINT,
                        wiki_pageid BIGINT,
                        wiki_title_bg VARCHAR(255),
                        wikidata_instances TEXT,
                        cadnum VARCHAR(100),
                        addr TEXT,
                        sunhrs_int_avg INTEGER,
                        t1600_max DECIMAL(10,2),
                        t2100_max DECIMAL(10,2),
                        longitude DECIMAL(12,8),
                        latitude DECIMAL(12,8),
                        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                    );
                    """
                    
                    # Create indexes for better performance
                    indexes_sql = [
                        "CREATE INDEX IF NOT EXISTS idx_buildings_gml_id ON buildings(gml_id);",
                        "CREATE INDEX IF NOT EXISTS idx_buildings_location ON buildings(longitude, latitude);",
                        "CREATE INDEX IF NOT EXISTS idx_buildings_function ON buildings(citygml_function);",
                        "CREATE INDEX IF NOT EXISTS idx_buildings_class ON buildings(citygml_class);",
                        "CREATE INDEX IF NOT EXISTS idx_buildings_height ON buildings(citygml_measured_height);",
                        "CREATE INDEX IF NOT EXISTS idx_buildings_cad_code ON buildings(cad_code);",
                        "CREATE INDEX IF NOT EXISTS idx_buildings_osm_id ON buildings(osm_id);"
                    ]
                    
                    # Execute SQL statements
                    cur.execute(buildings_sql)
                    
                    for index_sql in indexes_sql:
                        cur.execute(index_sql)
                    
                    conn.commit()
                    logger.info("✅ Database schema created successfully!")
                    return True
                    
        except Exception as e:
            logger.error(f"❌ Error creating schema: {e}")
            return False
    
    def load_buildings_csv(self, csv_path: str) -> bool:
        """Load buildings CSV data into PostgreSQL"""
        try:
            logger.info(f"📄 Loading buildings data from: {csv_path}")
            
            # Read CSV with proper delimiter
            df = pd.read_csv(csv_path, delimiter=';', encoding='utf-8', low_memory=False)
            logger.info(f"📊 Loaded {len(df)} building records")
            
            # Clean and prepare data
            df = df.rename(columns={
                'citygml_storeysAboveGround': 'citygml_storeys_above_ground',
                'citygml_creationDate': 'citygml_creation_date',
                'citygml_measured_height_units': 'citygml_measured_height_units',
                'lon': 'longitude',
                'lat': 'latitude'
            })
            
            # Convert date column
            if 'citygml_creation_date' in df.columns:
                df['citygml_creation_date'] = pd.to_datetime(df['citygml_creation_date'], errors='coerce')
            
            # Handle NaN values and empty strings for numeric columns
            numeric_columns = [
                'citygml_storeys_above_ground', 'citygml_measured_height', 'dtm2m_median',
                'citygml_class', 'citygml_function', 'dtm2m_min', 'cad_code',
                'energy_ti_ltb', 'energy_ti_utb', 'walk_access_index', 'walk_index',
                'walk_cu_raw', 'walk_cu_capped', 'osm_id', 'wiki_pageid',
                'sunhrs_int_avg', 't1600_max', 't2100_max', 'longitude', 'latitude'
            ]
            
            # Replace empty strings with NaN for numeric columns, then fill with None
            for col in numeric_columns:
                if col in df.columns:
                    df[col] = df[col].replace('', pd.NA)
                    df[col] = df[col].replace('nan', pd.NA)
            
            # Fill remaining NaN values with empty strings for text columns
            df = df.fillna('')
            
            with psycopg2.connect(**self.conn_params) as conn:
                with conn.cursor() as cur:
                    # Clear existing data
                    cur.execute("DELETE FROM buildings;")
                    
                    # Insert data in batches
                    batch_size = 1000
                    total_batches = (len(df) + batch_size - 1) // batch_size
                    
                    for i in range(0, len(df), batch_size):
                        batch = df.iloc[i:i + batch_size]
                        batch_num = i // batch_size + 1
                        
                        logger.info(f"🔄 Processing batch {batch_num}/{total_batches} ({len(batch)} records)")
                        
                        # Prepare insert statement
                        columns = list(batch.columns)
                        placeholders = ', '.join(['%s'] * len(columns))
                        insert_sql = f"""
                        INSERT INTO buildings ({', '.join(columns)})
                        VALUES ({placeholders})
                        ON CONFLICT (gml_id) DO UPDATE SET
                        updated_at = CURRENT_TIMESTAMP
                        """
                        
                        # Convert batch to list of tuples with proper data type handling
                        values = []
                        for _, row in batch.iterrows():
                            # Convert each row to a tuple, handling None values properly
                            row_tuple = []
                            for val in row:
                                if pd.isna(val) or val == '' or val == 'nan':
                                    row_tuple.append(None)
                                else:
                                    row_tuple.append(val)
                            values.append(tuple(row_tuple))
                        
                        # Execute batch insert
                        cur.executemany(insert_sql, values)
                        conn.commit()
                    
                    logger.info(f"✅ Successfully imported {len(df)} building records")
                    return True
                    
        except Exception as e:
            logger.error(f"❌ Error loading buildings CSV: {e}")
            return False
    
    
    def get_database_stats(self) -> Dict[str, Any]:
        """Get database statistics"""
        try:
            with psycopg2.connect(**self.conn_params) as conn:
                with conn.cursor(cursor_factory=RealDictCursor) as cur:
                    stats = {}
                    
                    # Get table count
                    cur.execute("SELECT COUNT(*) as count FROM buildings;")
                    result = cur.fetchone()
                    stats['buildings_count'] = result['count']
                    
                    # Get database size
                    cur.execute("""
                        SELECT pg_size_pretty(pg_database_size(current_database())) as size;
                    """)
                    result = cur.fetchone()
                    stats['database_size'] = result['size']
                    
                    # Get sample data
                    cur.execute("SELECT * FROM buildings LIMIT 1;")
                    buildings_sample = cur.fetchone()
                    stats['buildings_sample'] = dict(buildings_sample) if buildings_sample else None
                    
                    # Get some statistics
                    cur.execute("""
                        SELECT 
                            COUNT(*) as total_buildings,
                            AVG(citygml_measured_height) as avg_height,
                            MAX(citygml_measured_height) as max_height,
                            MIN(citygml_measured_height) as min_height,
                            COUNT(DISTINCT citygml_function) as unique_functions,
                            COUNT(DISTINCT citygml_class) as unique_classes
                        FROM buildings;
                    """)
                    result = cur.fetchone()
                    stats['summary_stats'] = dict(result)
                    
                    return stats
                    
        except Exception as e:
            logger.error(f"❌ Error getting database stats: {e}")
            return {"error": str(e)}
    
    def setup_complete_database(self, fresh_start: bool = True) -> bool:
        """Complete database setup process for buildings data only"""
        logger.info("🚀 Starting database setup for buildings data...")
        
        # Drop existing database if fresh_start is True
        if fresh_start:
            if not self.drop_database():
                return False
        
        # Create database
        if not self.create_database():
            return False
        
        # Test connection
        if not self.test_connection():
            return False
        
        # Create schema
        if not self.create_database_schema():
            return False
        
        # Load buildings CSV file
        buildings_csv = 'src/buildings_cad_2024_20250819.csv'
        
        if os.path.exists(buildings_csv):
            if self.load_buildings_csv(buildings_csv):
                logger.info("🎉 Database setup completed successfully!")
                
                # Get final stats
                stats = self.get_database_stats()
                logger.info(f"📊 Database Statistics:")
                logger.info(f"   - Buildings count: {stats.get('buildings_count', 0):,}")
                logger.info(f"   - Database size: {stats.get('database_size', 'Unknown')}")
                
                if 'summary_stats' in stats:
                    summary = stats['summary_stats']
                    logger.info(f"   - Average height: {summary.get('avg_height', 0):.2f}m")
                    logger.info(f"   - Max height: {summary.get('max_height', 0):.2f}m")
                    logger.info(f"   - Unique functions: {summary.get('unique_functions', 0)}")
                    logger.info(f"   - Unique classes: {summary.get('unique_classes', 0)}")
                
                return True
            else:
                logger.error("❌ Failed to load buildings CSV data")
                return False
        else:
            logger.error(f"❌ Buildings CSV file not found: {buildings_csv}")
            return False

def main():
    """Main function to set up the database"""
    print("🏗️ PostgreSQL Database Setup for CityBot WoT - Buildings Data")
    print("=" * 60)
    
    # Initialize database setup
    db_setup = PostgreSQLDatabaseSetup(
        host="127.0.0.1",
        port=5434,
        database="citybot_wot",
        user="postgres"
    )
    
    # Run complete setup
    success = db_setup.setup_complete_database()
    
    if success:
        print("\n✅ Database setup completed successfully!")
        print("\n💡 Next steps:")
        print("1. Connect to your database: sudo -u postgres psql -h 127.0.0.1 -p 5434 -d citybot_wot")
        print("2. Query your buildings data: SELECT * FROM buildings LIMIT 5;")
        print("3. Find tallest buildings: SELECT gml_id, citygml_measured_height, cad_descr FROM buildings ORDER BY citygml_measured_height DESC LIMIT 10;")
        print("4. Use the database in your RAG system")
    else:
        print("\n❌ Database setup failed. Please check the logs above.")

if __name__ == "__main__":
    main()
