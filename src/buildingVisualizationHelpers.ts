/**
 * Building Visualization Helper Functions
 * Contains utility functions for generating dynamic styles based on database data
 */

import { STYLE_DEFINITIONS } from './visualizationStyles';
import { getBuildingStatistics } from './database';

/**
 * Generate dynamic visualization styles based on database statistics
 * @param styleType - The type of style to generate (height, walkability, energyltb, energyutb)
 * @param stats - Database statistics containing min/max/average values
 * @returns Cesium 3D Tile Style definition
 */
export function generateDynamicStyle(styleType: string, stats: any): any {
  switch (styleType) {
    case 'height':
      // Parse strings to numbers - PostgreSQL returns numeric values as strings
      const heightMin = parseFloat(stats.height_min) || 0;
      const heightMax = parseFloat(stats.height_max) || 100;
      const heightAvg = parseFloat(stats.height_avg) || 20;
      
      return {
        color: {
          conditions: [
            [`Number(\${feature['citygml_measured_height']}) >= ${(heightMax * 0.8).toFixed(2)}`, "rgb(255, 0, 0)"], // Very tall - red
            [`Number(\${feature['citygml_measured_height']}) >= ${(heightAvg * 1.5).toFixed(2)}`, "rgb(255, 100, 0)"], // Tall - orange
            [`Number(\${feature['citygml_measured_height']}) >= ${heightAvg.toFixed(2)}`, "rgb(255, 200, 0)"], // Medium-tall - yellow
            [`Number(\${feature['citygml_measured_height']}) >= ${(heightAvg * 0.5).toFixed(2)}`, "rgb(0, 255, 0)"], // Medium - green
            [`Number(\${feature['citygml_measured_height']}) >= ${heightMin.toFixed(2)}`, "rgb(0, 200, 255)"], // Short - cyan
            ["true", "rgb(100, 100, 100)"] // Very short - gray
          ]
        }
      };

    case 'walkability':
      return {
        color: {
          conditions: [
            ["Number(\${feature['walk_access_index']}) >= 80", "rgb(0, 255, 0)"], // High walkability - green
            ["Number(\${feature['walk_access_index']}) >= 60", "rgb(100, 255, 0)"], // Good walkability - light green
            ["Number(\${feature['walk_access_index']}) >= 40", "rgb(255, 255, 0)"], // Medium walkability - yellow
            ["Number(\${feature['walk_access_index']}) >= 20", "rgb(255, 150, 0)"], // Low walkability - orange
            ["Number(\${feature['walk_access_index']}) >= 0", "rgb(255, 0, 0)"], // Very low walkability - red
            ["true", "rgb(150, 150, 150)"] // No data - gray
          ]
        }
      };

    case 'energyltb':
      // Parse strings to numbers - PostgreSQL returns numeric values as strings
      const energyMin = parseFloat(stats.energy_min) || 0;
      const energyMax = parseFloat(stats.energy_max) || 200;
      
      const threshold1 = (energyMin + (energyMax - energyMin) * 0.2).toFixed(2);
      const threshold2 = (energyMin + (energyMax - energyMin) * 0.4).toFixed(2);
      const threshold3 = (energyMin + (energyMax - energyMin) * 0.6).toFixed(2);
      const threshold4 = (energyMin + (energyMax - energyMin) * 0.8).toFixed(2);
      
      return {
        color: {
          conditions: [
            [`Number(\${feature['energy_ti_ltb']}) <= ${threshold1}`, "rgb(0, 255, 0)"], // Very efficient - green
            [`Number(\${feature['energy_ti_ltb']}) <= ${threshold2}`, "rgb(100, 255, 0)"], // Efficient - light green
            [`Number(\${feature['energy_ti_ltb']}) <= ${threshold3}`, "rgb(255, 255, 0)"], // Moderate - yellow
            [`Number(\${feature['energy_ti_ltb']}) <= ${threshold4}`, "rgb(255, 150, 0)"], // Inefficient - orange
            [`Number(\${feature['energy_ti_ltb']}) <= ${energyMax.toFixed(2)}`, "rgb(255, 0, 0)"], // Very inefficient - red
            ["true", "rgb(150, 150, 150)"] // No data - gray
          ]
        }
      };

    case 'energyutb':
      // Parse strings to numbers - PostgreSQL returns numeric values as strings
      const energyUtbMin = parseFloat(stats.energy_utb_min) || 0;
      const energyUtbMax = parseFloat(stats.energy_utb_max) || 300;
      
      const thresholdUtb1 = (energyUtbMin + (energyUtbMax - energyUtbMin) * 0.2).toFixed(2);
      const thresholdUtb2 = (energyUtbMin + (energyUtbMax - energyUtbMin) * 0.4).toFixed(2);
      const thresholdUtb3 = (energyUtbMin + (energyUtbMax - energyUtbMin) * 0.6).toFixed(2);
      const thresholdUtb4 = (energyUtbMin + (energyUtbMax - energyUtbMin) * 0.8).toFixed(2);
      
      return {
        color: {
          conditions: [
            [`Number(\${feature['energy_ti_utb']}) <= ${thresholdUtb1}`, "rgb(0, 255, 0)"], // Very efficient - green
            [`Number(\${feature['energy_ti_utb']}) <= ${thresholdUtb2}`, "rgb(100, 255, 0)"], // Efficient - light green
            [`Number(\${feature['energy_ti_utb']}) <= ${thresholdUtb3}`, "rgb(255, 255, 0)"], // Moderate - yellow
            [`Number(\${feature['energy_ti_utb']}) <= ${thresholdUtb4}`, "rgb(255, 150, 0)"], // Inefficient - orange
            [`Number(\${feature['energy_ti_utb']}) <= ${energyUtbMax.toFixed(2)}`, "rgb(255, 0, 0)"], // Very inefficient - red
            ["true", "rgb(150, 150, 150)"] // No data - gray
          ]
        }
      };

    default:
      return STYLE_DEFINITIONS[styleType] || { show: true };
  }
}

/**
 * Convert superlative terms to actual database thresholds
 * @param filterValue - The filter value (may contain superlatives)
 * @param filterType - The type of filter (walkability, height, energy)
 * @param dbStats - Database statistics
 * @returns Object with operator and value
 */
export function convertSuperlativeToThreshold(filterValue: string, filterType: string, dbStats: any): { operator: string; value: string } {
  let operator = filterValue.match(/^([><=]+)/)?.[1] || '>=';
  let value = filterValue.replace(/^[><=]+/, '');
  
  if (!dbStats) {
    return { operator, value };
  }
  
  const lowerValue = filterValue.toLowerCase();
  
  switch (filterType) {
    case 'walkability':
      if (lowerValue.includes('highest') || lowerValue.includes('best')) {
        operator = '>=';
        value = Math.max(80, dbStats.walkability_avg || 60).toString();
      } else if (lowerValue.includes('lowest') || lowerValue.includes('worst')) {
        operator = '<=';
        value = Math.min(20, dbStats.walkability_min || 10).toString();
      } else if (lowerValue.includes('average') || lowerValue.includes('medium')) {
        operator = '>=';
        value = (dbStats.walkability_avg || 50).toString();
      }
      break;
      
    case 'height':
      if (lowerValue.includes('tallest') || lowerValue.includes('highest')) {
        operator = '>=';
        value = Math.max(60, dbStats.height_avg || 30).toString();
      } else if (lowerValue.includes('shortest') || lowerValue.includes('lowest')) {
        operator = '<=';
        value = Math.min(10, dbStats.height_min || 5).toString();
      } else if (lowerValue.includes('average') || lowerValue.includes('medium')) {
        operator = '>=';
        value = (dbStats.height_avg || 20).toString();
      }
      break;
      
    case 'energy':
      if (lowerValue.includes('most efficient') || lowerValue.includes('best')) {
        operator = '<=';
        value = Math.min(50, dbStats.energy_min || 30).toString();
      } else if (lowerValue.includes('least efficient') || lowerValue.includes('worst')) {
        operator = '>=';
        value = Math.max(150, dbStats.energy_max || 200).toString();
      } else if (lowerValue.includes('average') || lowerValue.includes('medium')) {
        operator = '<=';
        value = (dbStats.energy_avg || 100).toString();
      }
      break;
  }
  
  return { operator, value };
}

/**
 * Get database statistics from the direct database connection
 * @returns Database statistics or null if unavailable
 */
export async function getDatabaseStatistics(): Promise<any | null> {
  try {
    return await getBuildingStatistics();
  } catch (error) {
    console.warn('⚠️ Could not fetch database statistics:', error);
    return null;
  }
}

/**
 * Color mapping for building classes
 */
export const BUILDING_CLASS_COLORS: { [key: string]: string } = {
  'administration': 'rgb(102, 194, 165)',
  'business, trade': 'rgb(252, 141, 98)',
  'storage': 'rgba(230, 12, 12, 1)',
  'schools, education, research': 'rgba(235, 42, 161, 1)',
  'industry': 'rgba(150, 235, 13, 1)',
  'habitation': 'rgb(255, 217, 47)',
  'culture': 'rgba(6, 28, 234, 1)',
  'traffic': 'rgba(135, 37, 37, 1)',
  'church institution': 'rgba(162, 0, 255, 1)',
  'healthcare': 'rgba(0, 255, 0, 1)',
  'function': 'rgba(102, 107, 255, 1)',
  'sport': 'rgb(44, 160, 44)'
};
