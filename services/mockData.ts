
import { LegacyItem, NewClassification, GlobalMapping } from '../types';

export const MOCK_LEGACY_BOM: LegacyItem[] = [
  {
    itemId: "BK-2024-MTB",
    description: "High Performance Mountain Bike V2",
    features: [
      { featureId: "FRM_MAT", description: "Frame Material", values: ["Aluminum 6061"] },
      { featureId: "WHL_SIZE", description: "Wheel Diameter", values: ["27.5", "29"] },
      { featureId: "DRV_SYS", description: "Drivetrain System", values: ["Shimano XT"] },
      { featureId: "SUSP_TYPE", description: "Suspension Configuration", values: ["Front Lockout", "Full Suspension"] }
    ]
  },
  {
    itemId: "BK-2024-ROAD",
    description: "Endurance Carbon Road Bike",
    features: [
      { featureId: "FRM_MAT", description: "Frame Material", values: ["Carbon Fiber T800"] },
      { featureId: "WHL_SIZE", description: "Wheel Diameter", values: ["700c"] },
      { featureId: "DRV_SYS", description: "Drivetrain System", values: ["SRAM Force eTap"] }
    ]
  },
  {
    itemId: "ACC-HELMET-01",
    description: "Aero Ventilation Helmet - M IPS",
    features: [
      { featureId: "CLR", description: "Exterior Color", values: ["Matte Black", "Gloss White"] },
      { featureId: "SZ", description: "Fit Size", values: ["M", "L"] },
      { featureId: "SAFETY", description: "Safety Standard", values: ["CE EN1078"] }
    ]
  }
];

export const MOCK_NEW_CLASSES: NewClassification[] = [
  {
    classId: "CLS_BICYCLE",
    className: "Complete Bicycle Assembly",
    attributes: [
      { attributeId: "MAT_COMP", description: "Material Composition", allowedValues: ["ALU_6061", "CARB_T800", "STEEL"] },
      { attributeId: "WHEEL_DIAM", description: "Standard Wheel Diameter", allowedValues: ["27.5IN", "29IN", "700C"] },
      { attributeId: "TRANS_GRP", description: "Transmission GroupSet" },
      { attributeId: "SUSP_MODE", description: "Suspension Mode" }
    ]
  },
  {
    classId: "CLS_APPAREL",
    className: "Safety Gear & Apparel",
    attributes: [
      { attributeId: "COLOR_EXT", description: "Primary External Color" },
      { attributeId: "SIZE_CAT", description: "Sizing Category" },
      { attributeId: "CERT_STD", description: "Certification Standard" }
    ]
  }
];

export const MOCK_GLOBAL_MAPPINGS: GlobalMapping[] = [
  {
    legacyFeatureIds: ["FRM_MAT"],
    newAttributeId: "MAT_COMP",
    valueMappings: {
      "Aluminum 6061": "ALU_6061",
      "Carbon Fiber T800": "CARB_T800"
    }
  },
  {
    legacyFeatureIds: ["WHL_SIZE"],
    newAttributeId: "WHEEL_DIAM",
    valueMappings: {
      "27.5": "27.5IN",
      "29": "29IN",
      "700c": "700C"
    }
  },
  {
    legacyFeatureIds: ["DRV_SYS"],
    newAttributeId: "TRANS_GRP",
    valueMappings: {}
  },
  {
    legacyFeatureIds: ["CLR"],
    newAttributeId: "COLOR_EXT",
    valueMappings: {}
  },
  {
    legacyFeatureIds: ["SZ"],
    newAttributeId: "SIZE_CAT",
    valueMappings: {}
  }
];
