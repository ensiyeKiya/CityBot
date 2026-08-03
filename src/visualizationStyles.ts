// Visualization style definitions for Sofia 3D building tiles
// Based on stylesManager.js from 3D-city-model

export const STYLE_DEFINITIONS: { [key: string]: any } = {
  none: {
    color: "color('white')",
    show: true
  },
  
  walkability: {
    defines: {
      walkability: "isNaN(Number(${feature['walk_access_index']})) ? 0 : Number(${feature['walk_access_index']})"
    },
    color: {
      conditions: [
        ["${feature['walk_access_index']} === undefined || isNaN(Number(${feature['walk_access_index']}))", "rgb(200,200,200)"],
        ["${walkability} >= 80", "rgb(88,140,126)"],
        ["${walkability} >= 60", "rgb(242,227,148)"],
        ["${walkability} >= 40", "rgb(242,174,114)"],
        ["${walkability} >= 20", "rgb(217,100,89)"],
        ["true", "rgb(128,0,0)"]
      ]
    }
  },
  
  height: {
    defines: {
      h: "isNaN(Number(${feature['citygml_measured_height']})) ? 0 : Number(${feature['citygml_measured_height']})"
    },
    color: {
      conditions: [
        ["${h} >= 65", "rgb(45, 0, 75)"],
        ["${h} >= 60", "rgb(102, 71, 151)"],
        ["${h} >= 55", "rgb(170, 162, 204)"],
        ["${h} >= 45", "rgb(224, 226, 238)"],
        ["${h} >= 30", "rgb(252, 230, 200)"],
        ["${h} >= 20", "rgb(248, 176, 87)"],
        ["${h} >= 6", "rgb(198, 106, 11)"],
        ["true", "rgb(127, 59, 8)"]
      ]
    }
  },
  
  uhi4: {
    defines: {
      t: "isNaN(Number(${feature['t1600_max']})) ? 0 : Number(${feature['t1600_max']})"
    },
    color: {
      conditions: [
        ["${t} > 28.56", "rgb(181, 21, 168)"],
        ["${t} >= 28.56", "rgb(205, 33, 85)"],
        ["${t} >= 28.38", "rgb(222, 54, 41)"],
        ["${t} >= 28.21", "rgb(230, 86, 56)"],
        ["${t} >= 28.00", "rgb(239, 118, 71)"],
        ["${t} >= 27.80", "rgb(247, 150, 86)"],
        ["${t} >= 27.71", "rgb(253, 178, 101)"],
        ["${t} >= 27.44", "rgb(253, 192, 117)"],
        ["${t} >= 27.17", "rgb(254, 206, 134)"],
        ["${t} >= 26.89", "rgb(254, 220, 150)"],
        ["${t} >= 26.62", "rgb(254, 234, 166)"],
        ["${t} >= 26.34", "rgb(255, 248, 183)"],
        ["${t} >= 26.07", "rgb(241, 249, 187)"],
        ["${t} >= 25.80", "rgb(214, 238, 178)"],
        ["${t} >= 25.52", "rgb(186, 227, 169)"],
        ["${t} >= 25.25", "rgb(162, 212, 166)"],
        ["${t} >= 24.97", "rgb(142, 194, 171)"],
        ["${t} >= 24.60", "rgb(121, 175, 175)"],
        ["${t} >= 24.33", "rgb(101, 157, 180)"],
        ["${t} >= 24.00", "rgb(81, 138, 184)"],
        ["${t} >= 23.88", "rgb(61, 120, 189)"],
        ["${t} >= 23.60", "rgb(40, 101, 193)"],
        ["${t} >= 23.30", "rgb(20, 83, 198)"],
        ["true", "rgb(127, 59, 8)"]
      ]
    }
  },
  
  uhi9: {
    defines: {
      t: "isNaN(Number(${feature['t2100_max']})) ? 0 : Number(${feature['t2100_max']})"
    },
    color: {
      conditions: [
        ["${t} > 26.36", "rgb(181, 21, 168)"],
        ["${t} >= 26.36", "rgb(205, 33, 85)"],
        ["${t} >= 26.08", "rgb(222, 54, 41)"],
        ["${t} >= 25.81", "rgb(230, 86, 56)"],
        ["${t} >= 25.54", "rgb(239, 118, 71)"],
        ["${t} >= 25.26", "rgb(247, 150, 86)"],
        ["${t} >= 24.99", "rgb(253, 178, 101)"],
        ["${t} >= 24.71", "rgb(253, 192, 117)"],
        ["${t} >= 24.44", "rgb(254, 206, 134)"],
        ["${t} >= 24.17", "rgb(254, 220, 150)"],
        ["${t} >= 23.89", "rgb(254, 234, 166)"],
        ["${t} >= 23.62", "rgb(255, 248, 183)"],
        ["${t} >= 23.34", "rgb(241, 249, 187)"],
        ["${t} >= 23.07", "rgb(214, 238, 178)"],
        ["${t} >= 22.80", "rgb(186, 227, 169)"],
        ["${t} >= 22.52", "rgb(162, 212, 166)"],
        ["${t} >= 22.25", "rgb(142, 194, 171)"],
        ["${t} >= 21.97", "rgb(121, 175, 175)"],
        ["${t} >= 21.70", "rgb(101, 157, 180)"],
        ["${t} >= 21.43", "rgb(81, 138, 184)"],
        ["${t} >= 21.15", "rgb(61, 120, 189)"],
        ["${t} >= 20.88", "rgb(40, 101, 193)"],
        ["${t} >= 20.60", "rgb(20, 83, 198)"],
        ["${t} >= 20.30", "rgb(0, 64, 202)"],
        ["true", "rgb(127, 59, 8)"]
      ]
    }
  },
  
  energyltb: {
    defines: {
      energyltb: "isNaN(Number(${feature['energy_ti_ltb']})) ? 0 : Number(${feature['energy_ti_ltb']})"
    },
    color: {
      conditions: [
        ["${energyltb} >= 66", "rgb(204, 34, 0)"],
        ["${energyltb} >= 62", "rgb(204, 34, 0)"],
        ["${energyltb} >= 58", "rgb(226, 72, 0)"],
        ["${energyltb} >= 54", "rgb(255, 119, 1)"],
        ["${energyltb} >= 51", "rgb(255, 156, 0)"],
        ["${energyltb} >= 48", "rgb(255, 205, 46)"],
        ["${energyltb} >= 45", "rgb(255, 239, 66)"],
        ["true", "rgb(127, 59, 8)"]
      ]
    }
  },
  
  energyutb: {
    defines: {
      energyutb: "isNaN(Number(${feature['energy_ti_utb']})) ? 0 : Number(${feature['energy_ti_utb']})"
    },
    color: {
      conditions: [
        ["${energyutb} >= 1050", "rgb(204, 34, 0)"],
        ["${energyutb} >= 900", "rgb(204, 34, 0)"],
        ["${energyutb} >= 750", "rgb(226, 72, 0)"],
        ["${energyutb} >= 600", "rgb(255, 119, 1)"],
        ["${energyutb} >= 450", "rgb(255, 156, 0)"],
        ["${energyutb} >= 300", "rgb(255, 205, 46)"],
        ["${energyutb} >= 150", "rgb(255, 239, 66)"],
        ["true", "rgb(127, 59, 8)"]
      ]
    }
  },
  
  class: {
    color: {
      conditions: [
        ["${citygml_class_description} === 'administration'", "rgb(102, 194, 165)"],
        ["${citygml_class_description} === 'business, trade'", "rgb(252, 141, 98)"],
        ["${citygml_class_description} === 'storage'", "rgba(230, 12, 12, 1)"],
        ["${citygml_class_description} === 'schools, education, research'", "rgba(235, 42, 161, 1)"],
        ["${citygml_class_description} === 'industry'", "rgba(150, 235, 13, 1)"],
        ["${citygml_class_description} === 'habitation'", "rgb(255, 217, 47)"],
        ["${citygml_class_description} === 'culture'", "rgba(6, 28, 234, 1)"],
        ["${citygml_class_description} === 'traffic'", "rgba(135, 37, 37, 1)"],
        ["${citygml_class_description} === 'church institution'", "rgba(162, 0, 255, 1)"],
        ["${citygml_class_description} === 'healthcare'", "rgba(255, 255, 255, 1)"],
        ["${citygml_class_description} === 'function'", "rgba(102, 107, 255, 1)"],
        ["${citygml_class_description} === 'sport'", "rgb(44, 160, 44)"],
        ["true", "rgba(0, 0, 0, 1)"]
      ]
    }
  }
};

export const STYLE_NAMES: { [key: string]: string } = {
  'none': 'Default',
  'walkability': 'Walkability Index',
  'height': 'Building Height',
  'uhi4': 'Urban Heat Island (4 PM)',
  'uhi9': 'Urban Heat Island (9 PM)',
  'energyltb': 'Energy Consumption (Lower Bound)',
  'energyutb': 'Energy Consumption (Upper Bound)',
  'class': 'Building Classification'
};

export const VALID_STYLES = ['none', 'walkability', 'height', 'uhi4', 'uhi9', 'energyltb', 'energyutb', 'class'];

