import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { GoogleGenerativeAI } from '@google/generative-ai'
import { createClient } from '@supabase/supabase-js'

type Bindings = {
  GEMINI_API_KEY: string
  OCRSPACE_API_KEY: string
  R2: R2Bucket
  SUPABASE_URL: string
  SUPABASE_KEY: string
  WORKERS_AI_API_TOKEN: string
  ACCOUNT_ID: string
}

// interface EnvVariables {
//   GEMINI_API_KEY: string;
//   OCRSPACE_API_KEY: string;
//   R2: string;
//   SUPABASE_URL: string;
//   SUPABASE_KEY: string;
//   WORKERS_AI_API_TOKEN: string;
// }

// const c.env: EnvVariables = {
//   GEMINI_API_KEY: process.env.GEMINI_API_KEY || '',
//   OCRSPACE_API_KEY: process.env.OCRSPACE_API_KEY || '',
//   R2: process.env.R2_BUCKET_NAME || '',
//   SUPABASE_URL: process.env.SUPABASE_URL || '',
//   SUPABASE_KEY: process.env.SUPABASE_KEY || '',
//   WORKERS_AI_API_TOKEN: process.env.WORKERS_AI_API_TOKEN || '',
// };

// console.log(c.env)

interface OcrResponse {
  ParsedResults: Array<{
    ParsedText: string;
  }>;
}

// Define the expected structure for embeddings// Define the expected structure for embeddings response
interface EmbeddingResponse {
  result: {
    shape: number[];
    data: number[][];
  };
  success: boolean;
  errors: any[];
  messages: any[];
}

// Input can be string or string[]
interface EmbeddingRequest {
  text: string | string[];
}

// Define the expected structure for question embedding
// interface QuestionEmbeddingResponse {
//   result: {
//     embedding: number[]; // Assuming question embedding is also an array of numbers
//   };
// }

// Define the expected structure for a document
interface Document {
  content: string;
  embedding: number[]; // Assuming the embedding is an array of numbers
  r2_key: string;
}

const app = new Hono<{ Bindings: Bindings }>()

// Configure CORS
app.use('/*', cors())

// Initialize Gemini
const initGemini = (apiKey: string) => {
  return new GoogleGenerativeAI(apiKey)
}

// Initialize Supabase
const initSupabase = (url: string, key: string) => {
  return createClient(url, key)
}

//var model = "@cf/baai/bge-base-en-v1.5"

// OCR endpoint
app.post('/api/ocr', async (c) => {
  const formData = await c.req.formData()
  const file = formData.get('file') as File

  if (!file) {
    return c.json({ error: 'No file provided' }, 400)
  }

  // Upload to R2
  const r2Key = `documents/${Date.now()}-${file.name}`
  await c.env.R2.put(r2Key, file);

  // Process with OCR Space
  const ocrResponse = await fetch('https://api.ocr.space/parse/image', {
    method: 'POST',
    headers: {
      'apikey': c.env.OCRSPACE_API_KEY,
    },
    body: formData
  })

  const ocrData: OcrResponse = await ocrResponse.json();
  //console.log(ocrData);
  const extractedText = ocrData.ParsedResults[0]?.ParsedText || '';

  //console.log(extractedText);

  const embedding: EmbeddingResponse = await fetch(`https://api.cloudflare.com/client/v4/accounts/${c.env.ACCOUNT_ID}/ai/run/@cf/baai/bge-base-en-v1.5`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${c.env.WORKERS_AI_API_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      text: extractedText // Can be string or string[]
    } as EmbeddingRequest)
  }).then(res => res.json());


  // Store in Supabase
  const supabase = initSupabase(c.env.SUPABASE_URL, c.env.SUPABASE_KEY);
  //console.log(supabase);
  try {
    // Insert the new document and embedding
    const { data, error } = await supabase.from('documents').insert([
      {content: extractedText, embedding: embedding.result.data[0], r2_key: r2Key}
    ]);
  
    // Check for any errors
    if (error) {
      throw new Error(error.message);
    }
  
    // If insertion was successful, log the inserted data
    console.log('Document inserted successfully:', data);
  
    // Optionally, confirm the insertion by checking if the data was returned
    if (data) {
      console.log('Inserted document:', data[0]);
    } else {
      console.error('No data returned after insertion.');
    }
  } catch (err: any) {
    //console.log(err);
    console.error('Error inserting document:', err.message);
  }


  return c.json({ success: true, text: extractedText })
})


// Chat endpoint
app.post('/api/chat', async (c) => {
  const { question } = await c.req.json()
  
  // Fix template string syntax and get question embedding
  const questionEmbedding: EmbeddingResponse = await fetch(`https://api.cloudflare.com/client/v4/accounts/${c.env.ACCOUNT_ID}/ai/run/@cf/baai/bge-base-en-v1.5`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${c.env.WORKERS_AI_API_TOKEN}`,
      'Content-Type': 'application/json'  // Add missing content-type header
    },
    body: JSON.stringify({
      text: question
    } as EmbeddingRequest)  // Add type assertion
  }).then(res => res.json())

  const supabase = initSupabase(c.env.SUPABASE_URL, c.env.SUPABASE_KEY)

  // Get the first embedding from the data array
  let { data: similarDocs } = await supabase.rpc('match_documents', {
    query_embedding: questionEmbedding.result.data[0], // Extract first embedding
    match_threshold: 0.7,
    match_count: 3
  })

  // Add null check for similarDocs
  const context = (similarDocs || []).map((doc: Document) => doc.content).join('\n\n')

  console.log(context);

  // Get response from Gemini
  const genAI = initGemini(c.env.GEMINI_API_KEY);
  const model = genAI.getGenerativeModel({ model: 'gemini-pro' })
  
  const prompt = `
    Context: ${context}
    
    Question: ${question}
    
    Please answer the question based on the context provided.
  `

  const result = await model.generateContent(prompt)
  const response = result.response.text()

  return c.json({ answer: response })
})

export default app 