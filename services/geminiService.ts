
import { GoogleGenAI, Type } from "@google/genai";
import { LegacyItem, NewClassification, AIClassificationSuggestion } from "../types";

const MAX_RETRIES = 3;

async function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function suggestClassification(
  item: LegacyItem,
  availableClasses: NewClassification[]
): Promise<AIClassificationSuggestion[]> {
  // Always create a new GoogleGenAI instance right before making an API call 
  // to ensure it uses the most current configuration.
  const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
  const model = "gemini-3-flash-preview";
  
  const classList = availableClasses.map(c => `${c.classId}: ${c.className}`).join("\n");
  
  const prompt = `
    Analyze this legacy product data and suggest the best matching ERP classification.
    Item: ${item.itemId}
    Description: ${item.description}
    Features: ${JSON.stringify(item.features)}
    
    Available Classifications:
    ${classList}
    
    Return a JSON array of suggestions with classId, confidence (0-1), and a short reason.
  `;

  let lastError: any = null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await ai.models.generateContent({
        model,
        contents: prompt,
        config: {
          responseMimeType: "application/json",
          responseSchema: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                classId: { type: Type.STRING },
                confidence: { type: Type.NUMBER },
                reason: { type: Type.STRING }
              },
              required: ["classId", "confidence", "reason"]
            }
          }
        }
      });

      // Directly access the .text property from GenerateContentResponse as per guidelines.
      const text = response.text;
      return JSON.parse(text || "[]");
    } catch (error: any) {
      lastError = error;
      const isQuotaError = error?.message?.includes("429") || error?.message?.includes("RESOURCE_EXHAUSTED");
      
      if (isQuotaError && attempt < MAX_RETRIES) {
        const waitTime = Math.pow(2, attempt) * 1000;
        console.warn(`Gemini Quota reached. Retrying in ${waitTime}ms (Attempt ${attempt + 1}/${MAX_RETRIES})...`);
        await sleep(waitTime);
        continue;
      }
      
      // If it's not a quota error or we've exhausted retries, break and throw
      console.error("AI suggestion failed after retries:", error);
      break;
    }
  }

  throw lastError;
}
