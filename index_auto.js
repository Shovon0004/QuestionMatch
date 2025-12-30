const { GoogleGenerativeAI } = require("@google/generative-ai");
const { GoogleAIFileManager } = require("@google/generative-ai/server");
const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const sharp = require('sharp');

// --- Configuration ---
require('dotenv').config();
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const ACCESS_TOKEN = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJuYW1lIjoiTWFodGFiIEFsYW0iLCJyb2xlIjoic3VwZXJfYWRtaW4iLCJ1c2VySWQiOiI2ODcxZjAyZjg1MTIxNzhiMTFjZDZjNjgiLCJpYXQiOjE3NjUxNjkxMTgsImV4cCI6MTc5NjcwNTExOH0.f0wbIaGBRQQJ0pnv8gImO59WfieKZPG2Hk8MR1jwYA0";
const API_BASE_URL = "https://dev.content.intelliedtech.com/api/v1";

// Default Context (Fallback)
const DEFAULTS = {
    curriculumId: "66ebcb876c2814d47a948f0b",
    gradeId: "66ebcb876c2814d47a948f0c", // We assume Grade is known/fixed for now
    exam: "General Science",
    level: "Medium",
    paper: JSON.stringify(["Paper 3"])
};

// Initialize Gemini
// Using gemini-2.0-flash-exp if possible for speed/intelligence, or fallback to reliable
// User had quota issues with 2.5-flash. Let's try gemini-1.5-flash-8b (lighter) or stay with flash-lite
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const fileManager = new GoogleAIFileManager(GEMINI_API_KEY);
// Use Gemini 2.5 Flash Lite - User preference
const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash-lite" });

// --- FILES ---
const QP_FILE_PATH = path.join(__dirname, "0580_m25_qp_42.pdf");
const MS_FILE_PATH = path.join(__dirname, "0580_m25_ms_42.pdf"); // Marking Scheme
const IMAGES_DIR = path.join(__dirname, "processed_images");

// --- API & Discovery Results ---
const NEW_DEFAULTS = {
    curriculumId: "69133297c9ba04bf0af29ae6", // IGCSE (CAMBRIDGE)
    gradeId: "69133297c9ba04bf0af29ae9", // 9th and 10th
    subjectId: "", // Will be auto-detected
    exam: "IGCSE",
    year: [2025],
    month: ["March"],
    paper: ["Paper 4", "Variant 2"], // Proper format
    criteria: "Total Marks: 130"
};

let discoveredContext = { ...NEW_DEFAULTS };
const headers = { 'Authorization': `Bearer ${ACCESS_TOKEN}` };

// --- UTILS: Retry & JSON Repair ---

async function withRetry(fn, retries = 10, delay = 60000) {
    for (let i = 0; i < retries; i++) {
        try {
            return await fn();
        } catch (error) {
            const isQuota = error.message.includes("429") || error.message.includes("Quota") || error.message.includes("503") || error.message.includes("Overloaded");
            if (isQuota && i < retries - 1) {
                console.log(`    [Wait] Limit Hit. Sleeping 60s... (Attempt ${i + 1}/${retries})`);
                await new Promise(r => setTimeout(r, delay));
            } else {
                throw error;
            }
        }
    }
}

function repairJson(jsonStr) {
    if (!jsonStr) return "{}";

    // 1. Remove Markdown code blocks
    let clean = jsonStr.replace(/```json/g, '').replace(/```/g, '').trim();

    // 2. Remove control characters except newlines (which we'll handle separately)
    clean = clean.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "");

    // 3. Try parsing first
    try {
        JSON.parse(clean);
        return clean;
    } catch (e) {
        console.warn(`    [JSON Repair] ${e.message.substring(0, 80)}`);
    }

    // 4. Aggressive repair: Replace problematic patterns
    // Fix unescaped quotes in strings (very basic - looks for ": "..." patterns)
    // This is imperfect but helps with common cases

    // Fix unescaped newlines: replace actual newline with space
    clean = clean.replace(/\n/g, ' ');

    // Fix unescaped backslashes (but not already escaped ones or valid escapes)
    // We allow \", \\, \/, \b, \f, \n, \r, \t, and \uXXXX
    clean = clean.replace(/\\(?!["\\/bfnrtu]|u[0-9a-fA-F]{4})/g, '\\\\');

    // Try again
    try {
        JSON.parse(clean);
        return clean;
    } catch (e) {
        console.warn(`    [JSON Repair Failed] Returning empty structure`);
        return '{"questions":[]}';
    }
}

// --- API Functions ---
async function fetchSubjects(gradeId) {
    try {
        const res = await axios.get(`${API_BASE_URL}/curriculum/grade/${gradeId}/subject`, { headers });
        return res.data.data || [];
    } catch (e) { return []; }
}

async function fetchChapters(subjectId) {
    try {
        const res = await axios.get(`${API_BASE_URL}/curriculum/subject/${subjectId}/chapter`, { headers });
        return res.data.data || [];
    } catch (e) { return []; }
}

async function fetchTopics(chapterId) {
    try {
        const res = await axios.get(`${API_BASE_URL}/curriculum/chapter/${chapterId}/topic`, { headers });
        return res.data.data || [];
    } catch (e) { return []; }
}

async function fetchSubtopics(topicId) {
    try {
        const res = await axios.get(`${API_BASE_URL}/curriculum/topic/${topicId}/subtopic`, { headers });
        return res.data.data || [];
    } catch (e) { return []; }
}

// ... (Subject Fetching logic remains but we use NEW_DEFAULTS.subjectId as primary)

// --- STEP 1: Upload MS (Reference)
// --- STEP 3: Process Pages ---

async function convertPdfToImages() {
    if (!fs.existsSync(QP_FILE_PATH)) {
        console.error("QP File not found:", QP_FILE_PATH);
        return [];
    }
    if (fs.existsSync(IMAGES_DIR)) fs.rmSync(IMAGES_DIR, { recursive: true, force: true });
    fs.mkdirSync(IMAGES_DIR);
    console.log("Converting QP PDF to images...");
    try {
        execSync(`pdftoppm -png -r 200 "${QP_FILE_PATH}" "${path.join(IMAGES_DIR, 'page')}"`);
        return fs.readdirSync(IMAGES_DIR).filter(f => f.endsWith('.png')).sort((a, b) => parseInt(a.match(/\d+/)) - parseInt(b.match(/\d+/))).map(f => path.join(IMAGES_DIR, f));
    } catch (e) {
        console.error("PDF Conversion Failed:", e.message);
        return [];
    }
}

async function uploadToGemini(filePath) {
    const uploadResult = await fileManager.uploadFile(filePath, { mimeType: "image/png", displayName: path.basename(filePath) });
    let myFile = await fileManager.getFile(uploadResult.file.name);
    while (myFile.state === "PROCESSING") { await new Promise(r => setTimeout(r, 1000)); myFile = await fileManager.getFile(uploadResult.file.name); }
    return uploadResult.file;
}

let msFileUri = null;
let answerBank = {}; // Global answer bank: { "1(a)": {answer, solution, ...}, "1(b)": {...} }

async function prepareMarkingScheme() {
    console.log("Uploading Marking Scheme to Gemini Context...");
    try {
        const uploadResult = await fileManager.uploadFile(MS_FILE_PATH, { mimeType: "application/pdf", displayName: "Marking Scheme" });
        let myFile = await fileManager.getFile(uploadResult.file.name);
        while (myFile.state === "PROCESSING") {
            process.stdout.write(".");
            await new Promise(r => setTimeout(r, 2000));
            myFile = await fileManager.getFile(uploadResult.file.name);
        }
        console.log(`\nMarking Scheme Ready: ${myFile.uri}`);
        return myFile.uri;
    } catch (e) {
        console.error("Failed to upload MS:", e.message);
        return null;
    }
}

// NEW: Process entire MS PDF once to extract ALL answers
// NEW: Process entire MS PDF page-by-page as images to extract ALL answers
// NEW: Robust Text-Based Answer Extraction
async function buildAnswerBank() {
    console.log("\n=== Building Answer Bank (Robust Text Method) ===");

    // Step 1: Convert MS PDF to images
    const MS_IMAGES_DIR = path.join(__dirname, 'ms_images');
    if (fs.existsSync(MS_IMAGES_DIR)) fs.rmSync(MS_IMAGES_DIR, { recursive: true, force: true });
    fs.mkdirSync(MS_IMAGES_DIR);

    try {
        execSync(`pdftoppm -png -r 200 "${MS_FILE_PATH}" "${path.join(MS_IMAGES_DIR, 'ms_page')}"`);
    } catch (e) { console.error("MS Conversion failed:", e.message); return; }

    const msImagePaths = fs.readdirSync(MS_IMAGES_DIR)
        .filter(f => f.endsWith('.png'))
        .sort((a, b) => parseInt(a.match(/\d+/)) - parseInt(b.match(/\d+/)))
        .map(f => path.join(MS_IMAGES_DIR, f));

    console.log(`✓ Converted MS to ${msImagePaths.length} images`);

    // Step 2: Process each MS page
    msPageUris = []; // Reset global array
    for (let i = 0; i < msImagePaths.length; i++) {
        process.stdout.write(`Processing MS Page ${i + 1}/${msImagePaths.length} `);
        const msPageFile = await uploadToGemini(msImagePaths[i]);
        msPageUris[i] = msPageFile.uri; // Store for later use

        // RECITAION-SAFE PROMPT - TARGETING TABLE STRUCTURE
        const extractPrompt = `
        You are a Data Processor extracting structured data from a Marking Scheme Table.
        
        The data is presented in a table with columns: "Question", "Answer", "Marks", "Guidance/Partial Marks".
        
        TASK:
        Extract ONLY rows where the "Question" column contains a valid question identifier (e.g., 1, 1(a), 2(b)(ii)).
        Ignore cover pages, general marking principles, or header text.
        
        STRUCTURE FORMAT:
        Q: [Question Identifier]
        A: [Answer Content]
        S: [Partial Marks / Guidance Content]
        M: [Marks]
        
        Example from image:
        Q: 1
        A: 2 or 7
        S: 
        M: 1
        
        Q: 2
        A: 3y^2 + 5y
        S: B1 for 3y^2 or 5y correct
        M: 2
        
        PROCESS ALL VALID TABLE ROWS.
        `;

        try {
            const result = await withRetry(() => model.generateContent({
                contents: [{ role: 'user', parts: [{ text: extractPrompt }, { fileData: { fileUri: msPageFile.uri, mimeType: "image/png" } }] }]
            }));

            const text = result.response.text();

            // MANUAL PARSING of the simple text format
            // Split by Q: or "Question:" or just start of new block
            const blocks = text.split(/(?:^|\n)(?:Q[:.]|Question[:\s])/i).filter(b => b.trim().length > 0);

            let Count = 0;
            for (const block of blocks) {
                const lines = block.split('\n');
                const qNum = lines[0].trim();

                // Simple parser for fields
                let answer = "", solution = "", marks = "1";
                let currentSection = "";

                for (let j = 1; j < lines.length; j++) {
                    const line = lines[j].trim();
                    if (/^(?:A[:.]|Answer[:\s])/i.test(line)) {
                        currentSection = 'A';
                        answer = line.replace(/^(?:A[:.]|Answer[:\s])\s*/i, '').trim();
                    }
                    else if (/^(?:S[:.]|Step[:\s]|Solution[:\s])/i.test(line)) {
                        currentSection = 'S';
                        solution = line.replace(/^(?:S[:.]|Step[:\s]|Solution[:\s])\s*/i, '').trim();
                    }
                    else if (/^(?:M[:.]|Mark[:\s]|Point[:\s])/i.test(line)) {
                        currentSection = 'M';
                        marks = line.replace(/^(?:M[:.]|Mark[:\s]|Point[:\s])\s*/i, '').trim();
                    }
                    else if (line.length > 0) {
                        if (currentSection === 'A') answer += " " + line;
                        if (currentSection === 'S') solution += " " + line + ". ";
                    }
                }

                // VALIDATION: Strict regex for Question Number (e.g. "1", "1(a)", "2(b)(i)")
                const isValidQ = /^\d+([a-z]|\([a-ziv]+\))*$/i.test(qNum.replace(/[\(\)]/g, ''));
                // Note: The regex above is simplified. Let's trust "starts with digit" primarily.
                const startsWithDigit = /^\d/.test(qNum);

                if (startsWithDigit && (answer || solution)) {
                    // Create formatted HTML for final storing
                    const formattedSolution = solution
                        ? `<p><strong>Solution:</strong></p><p>${solution.replace(/\./g, '.</p><p>')}</p>`
                        : `<p>Refer to marking scheme calculation.</p>`;

                    answerBank[qNum] = {
                        questionNumber: qNum,
                        msPageIndex: i, // Store which page of MS this answer is on
                        answer: answer || "See Solution",
                        solution: formattedSolution,
                        explanation: "IGCSE Standard Method",
                        point: parseInt(marks) || 1,
                        level: (parseInt(marks) || 1) > 4 ? "Hard" : ((parseInt(marks) || 1) > 2 ? "Medium" : "Easy")
                    };
                    Count++;
                }
            }
            console.log(`-> Found ${Count} answers`);

        } catch (e) {
            console.warn(`[Error] MS Page ${i + 1}: ${e.message}`);
        }

        if (i < msImagePaths.length - 1) await new Promise(r => setTimeout(r, 1500));
    }

    console.log(`\n✓ Answer Bank Ready: ${Object.keys(answerBank).length} answers total.`);
    try { fs.rmSync(MS_IMAGES_DIR, { recursive: true, force: true }); } catch (e) { }
}


// --- STEP 1: Auto-Detect Subject (Robust) ---
async function autoDetectSubject(firstPageImagePath) {
    console.log("Auto-Detecting Subject from PDF content...");

    // 1. Get available subjects from API
    // We use NEW_DEFAULTS.gradeId as the base
    const subjects = await fetchSubjects(NEW_DEFAULTS.gradeId);
    if (subjects.length === 0) {
        console.warn("  [Warning] No subjects found in API for this Grade. Using Default.");
        return NEW_DEFAULTS.subjectId;
    }

    const subjectList = subjects.map(s => `- ${s.name} (ID: ${s._id})`).join("\n");
    console.log(`  > Available Subjects:\n${subjectList}`);

    const file = await uploadToGemini(firstPageImagePath);
    const prompt = `
    Analyze this exam paper page.
    1. Identify the SUBJECT (e.g. Mathematics, Physics, English).
    2. Extract the YEAR, MONTH, and PAPER NUMBER from the text (e.g. "March 2025", "Paper 4") if visible.
    3. Select the BEST MATCH from the provided list of Available Subjects.
    
    Available Subjects:
    ${subjectList}
    
    Output JSON: 
    { 
      "subjectId": "THE_MATCHED_ID", 
      "subjectName": "NAME",
      "year": 2025,
      "month": "March",
      "paper": "Paper 4" 
    }
    `;

    try {
        const result = await withRetry(() => model.generateContent([
            prompt,
            { fileData: { fileUri: file.uri, mimeType: "image/png" } }
        ]));
        const text = result.response.text();
        const json = JSON.parse(repairJson(text));

        console.log(`  -> Detected Metadata: ${JSON.stringify(json)}`);

        // Update Globals if detected (Override defaults)
        if (json.year) NEW_DEFAULTS.year = [json.year];
        if (json.month) NEW_DEFAULTS.month = [json.month];
        if (json.paper) NEW_DEFAULTS.paper = [json.paper];

        return json.subjectId || subjects[0]._id;
    } catch (e) {
        console.error("  -> Failed to detect subject via AI. Fallback to default.");
        return NEW_DEFAULTS.subjectId;
    }
}

// --- STEP 2: Build Map ---
async function buildFullCurriculumMap(subjectId) {
    console.log(`Building Knowledge Map for Subject ID: ${subjectId}...`);
    discoveredContext.subjectId = subjectId;
    NEW_DEFAULTS.subjectId = subjectId; // Sync

    const chapters = await fetchChapters(subjectId);
    let mapString = "FULL CURRICULUM MUTATION TREE (Use these IDs):\n";
    if (chapters.length === 0) return "No Curriculum Found (Use General Knowledge)";

    for (const chapter of chapters) {
        process.stdout.write(`  > ${chapter.name}`);
        mapString += `\n[CHAPTER] "${chapter.name}" (ID: ${chapter._id})\n`;
        const topics = await fetchTopics(chapter._id);

        for (const topic of topics) {
            const subtopics = await fetchSubtopics(topic._id);
            if (subtopics.length > 0) {
                mapString += `   - Topic: "${topic.name}" (ID: ${topic._id})\n`;
                subtopics.forEach(s => mapString += `      ~ Subtopic: "${s.name}" (ID: ${s._id})\n`);
            } else {
                mapString += `   - Topic: "${topic.name}" (ID: ${topic._id}) [No Subtopics]\n`;
            }
        }
        process.stdout.write(" [OK]\n");
    }
    return mapString;
}

// Normalize questionType to valid enum values
function normalizeQuestionType(type) {
    if (!type) return "subjective";

    const validTypes = ["objective", "subjective", "mcq-multiple", "true-false", "match", "sort", "classify", "graph", "drawing", "attach-file"];

    // If already valid, return as-is
    if (validTypes.includes(type.toLowerCase())) return type.toLowerCase();

    // Map common invalid types
    const typeMap = {
        "unknown": "subjective",
        "free response": "subjective",
        "free-response": "subjective",
        "calculation": "subjective",
        "written": "subjective",
        "grid shading": "drawing",
        "shading": "drawing",
        "sketch": "drawing",
        "diagram": "drawing",
        "mcq": "objective",
        "multiple choice": "objective",
        "tf": "true-false"
    };

    const normalized = typeMap[type.toLowerCase()];
    if (normalized) return normalized;

    // Default fallback
    console.warn(`    [Warning] Unknown questionType "${type}", defaulting to "subjective"`);
    return "subjective";
}

// Normalize level to valid enum values
function normalizeLevel(level) {
    if (!level) return "Medium";

    const validLevels = ["Easy", "Medium", "Hard"];

    // If already valid, return as-is
    if (validLevels.includes(level)) return level;

    // Map common invalid levels
    const levelMap = {
        "low": "Easy",
        "basic": "Easy",
        "simple": "Easy",
        "moderate": "Medium",
        "average": "Medium",
        "high": "Hard",
        "difficult": "Hard",
        "challenging": "Hard",
        "complex": "Hard"
    };

    const normalized = levelMap[level.toLowerCase()];
    if (normalized) return normalized;

    // Default fallback
    console.warn(`    [Warning] Unknown level "${level}", defaulting to "Medium"`);
    return "Medium";
}

async function analyzePage(imagePath, pageIndex, curriculumMapString) {
    console.log(`Analyzing page ${pageIndex + 1}...`);
    const qpFile = await uploadToGemini(imagePath);

    // STEP 1: Extract questions from QP page (without MS context for clarity)
    const extractPrompt = `
    You are analyzing a Question Paper page. Extract ALL questions with COMPLETE, DETAILED text.
    
    CRITICAL RULES FOR QUESTION EXTRACTION:
    
    1. QUESTION TEXT - Extract COMPLETE question with FULL CONTEXT:
       - Include question number (e.g., "1(a)", "2(b)(i)")
       - Include ALL introductory text, context, and given information
       - Include ALL parts (a), (b), (c) if multi-part
       - Include any formulas, data, or conditions given
       - Format in HTML: <p> for paragraphs, <strong> for emphasis, <em> for variables
       
       EXAMPLE - GOOD:
       "<p><strong>Question 1(a):</strong></p><p>The area, <em>A</em>, of a circle is given...</p>"
    
    2. MATHEMATICAL FORMATTING (LATEX + HTML):
       - Use LaTeX for complex equations but YOU MUST ESCAPE BACKSLASHES for JSON string safety.
       - Example: "Area = \\\\pi r^2" (Double backslash in JSON string -> Single in final string)
       - If unsure, use HTML. But LaTeX is preferred for "beautiful" math.
       - Inline Math: $...$  (e.g., "$A = \\\\pi r^2$")
       - Block Math: $$...$$
       
       EXAMPLE JSON STRING:
       "question": "<p>Calculate the area.</p><p>$$A = \\\\pi r^2$$</p>"
    
    3. DIAGRAMS - If question has diagram/graph/image:
       - Set hasDiagram: true
       - Provide ACCURATE bbox [ymin, xmin, ymax, xmax] in 0-1000 scale
       - bbox should tightly bound ONLY the diagram (not text)
    
    4. QUESTION TYPE:
       - "subjective" (calculation/explanation), "objective" (MCQ), "drawing", "graph"
    
    5. MAP TO CURRICULUM (CRITICAL):
       - You MUST select the most relevant "chapterId", "topicId", and "subtopicId" from the provided list.
       - Look for keywords in the question (e.g. "circle" -> Geometry, "graph" -> Algebra).
       - DO NOT LEAVE EMPTY. Pick the best fit.
       
    ${curriculumMapString}
    
    OUTPUT JSON (Strictly Valid JSON):
    - Escape double quotes inside strings: \\"
    - Do NOT use control characters or unescaped backslashes.
    {
      "questions": [
        {
          "questionNumber": "1(a)",
          "question": "<p>...</p>",
          "questionType": "subjective",
          "hasDiagram": false,
          "bbox": [0, 0, 0, 0],
          "chapterId": "...",
          "topicId": "...",
          "subtopicId": "..."
        }
      ]
    }
    `;

    let questions = [];
    try {
        const extractResult = await withRetry(() => model.generateContent({
            contents: [{ role: 'user', parts: [{ text: extractPrompt }, { fileData: { fileUri: qpFile.uri, mimeType: "image/png" } }] }],
            generationConfig: { responseMimeType: "application/json" }
        }));

        let cleaned = repairJson(extractResult.response.text());
        let parsed = JSON.parse(cleaned);
        questions = parsed.questions || [];
    } catch (e) {
        console.error(`    [Error] Extracting questions: ${e.message}`);
        return { questions: [] };
    }

    // STEP 2: Match answers from global answer bank
    if (Object.keys(answerBank).length > 0 && questions.length > 0) {
        console.log(`    [Matching] Using answer bank with ${Object.keys(answerBank).length} answers`);

        // Async matching to allow for Visual Solution Generation
        const matchPromises = questions.map(async q => {
            const qNum = q.questionNumber;
            const bankEntry = answerBank[qNum];

            if (qNum && bankEntry) {
                let enrichedInfo = { ...bankEntry };

                // VISUAL ENHANCEMENT
                // If we have the MS page image, generate a better solution 
                if (typeof bankEntry.msPageIndex === 'number' && msPageUris[bankEntry.msPageIndex]) {
                    process.stdout.write('.'); // Progress indicator
                    const visualSol = await generateVisualSolution(q.question, qNum, msPageUris[bankEntry.msPageIndex]);
                    if (visualSol && visualSol.solution) {
                        enrichedInfo.solution = visualSol.solution;
                        if (visualSol.explanation) enrichedInfo.explanation = visualSol.explanation;
                    }
                }

                console.log(`    [✓] Matched ${qNum} (Visual Enhanced)`);
                return { ...q, ...enrichedInfo };
            } else {
                console.warn(`    [✗] No answer in bank for ${qNum}`);
                return q;
            }
        });

        questions = await Promise.all(matchPromises);
    } else if (questions.length > 0) {
        console.warn(`    [Warning] Answer bank is empty, questions will have no solutions`);
    }

    // STEP 3: Validate and normalize - ONLY keep questions with answers
    const beforeFilter = questions.length;
    questions = questions.filter(q => {
        if (!q.answer || !q.solution) {
            console.warn(`    [Skip] Question ${q.questionNumber || 'Unknown'} - missing answer or solution`);
            return false;
        }
        if (!q.question || q.question.length < 20) {
            console.warn(`    [Skip] Question ${q.questionNumber || 'Unknown'} - incomplete question text`);
            return false;
        }
        return true;
    }).map(q => {
        q.questionType = normalizeQuestionType(q.questionType || "subjective");
        q.level = normalizeLevel(q.level || "Medium");
        q.point = q.point || 1;
        return q;
    });

    return { questions };
}

async function cropAndUpload(questionData, sourceImagePath) {
    // ... Same Logic ...
    let imageStream = null;
    process.stdout.write(`  [Q] ${questionData.question ? questionData.question.substring(0, 20) : "Unknown"}... `);

    // Bbox cropping
    if (questionData.hasDiagram && questionData.bbox && questionData.bbox.length === 4) {
        try {
            const m = await sharp(sourceImagePath).metadata();
            let [y1, x1, y2, x2] = questionData.bbox;
            // Add padding (2.5% to avoid cutting off)
            y1 = Math.max(0, y1 - 25); x1 = Math.max(0, x1 - 25);
            y2 = Math.min(1000, y2 + 25); x2 = Math.min(1000, x2 + 25);
            const t = Math.floor((y1 / 1000) * m.height), l = Math.floor((x1 / 1000) * m.width), h = Math.floor(((y2 - y1) / 1000) * m.height), w = Math.floor(((x2 - x1) / 1000) * m.width);
            if (w > 0 && h > 0) {
                imageStream = await sharp(sourceImagePath).extract({ left: l, top: t, width: w, height: h }).toBuffer();
                process.stdout.write("[Diagram] ");
            }
        } catch (e) { }
    }

    const form = new FormData();
    // Core Fields
    form.append('question', questionData.question || "");
    form.append('questionType', questionData.questionType || "subjective");
    form.append('point', questionData.point || questionData.marks || 1);
    form.append('level', questionData.level || "Medium");

    // Complex Fields
    if (questionData.options) form.append('options', JSON.stringify(questionData.options));
    if (questionData.solution) form.append('solution', questionData.solution);
    if (questionData.explanation) form.append('explanation', questionData.explanation);
    if (questionData.answer) form.append('answer', questionData.answer);
    if (questionData.mathSolution) form.append('mathSolution', questionData.mathSolution);

    // IDs (Use NEW_DEFAULTS)
    if (questionData.chapterId) form.append('chapterId', questionData.chapterId);
    if (questionData.topicId) form.append('topicId', questionData.topicId);
    if (questionData.subtopicId) form.append('subtopicId', questionData.subtopicId);

    // Context from NEW_DEFAULTS (User Request)
    form.append('curriculumId', NEW_DEFAULTS.curriculumId);
    form.append('gradeId', NEW_DEFAULTS.gradeId);
    form.append('subjectId', NEW_DEFAULTS.subjectId);
    form.append('exam', NEW_DEFAULTS.exam);

    // Year and Month - send as simple values, not arrays
    const year = Array.isArray(NEW_DEFAULTS.year) ? NEW_DEFAULTS.year[0] : NEW_DEFAULTS.year;
    const month = Array.isArray(NEW_DEFAULTS.month) ? NEW_DEFAULTS.month[0] : NEW_DEFAULTS.month;

    form.append('year', year);
    form.append('month', month);
    form.append('paper', JSON.stringify(NEW_DEFAULTS.paper));

    if (questionData.tags) form.append('tags', JSON.stringify(questionData.tags));
    else form.append('tags', JSON.stringify(["Auto"]));

    if (imageStream) form.append('file', imageStream, { filename: 'diagram.png', contentType: 'image/png' });

    // Debug: Log year/month being sent (only for first question)
    if (Math.random() < 0.1) { // Log ~10% of requests to avoid spam
        console.log(`\n[DEBUG] Sending: year=${year}, month=${month}, paper=${JSON.stringify(NEW_DEFAULTS.paper)}`);
    }

    try {
        const res = await axios.post(`${API_BASE_URL}/question/create-question`, form, { headers: { ...form.getHeaders(), 'Authorization': `Bearer ${ACCESS_TOKEN}` } });
        console.log(`OK (${res.data?.data?._id || 'Success'})`);
    } catch (e) {
        console.log(`FAIL: ${e.message}`);
        if (e.response && e.response.data) console.log(JSON.stringify(e.response.data));
    }
}

async function main() {
    try {
        const imagePaths = await convertPdfToImages();
        if (imagePaths.length === 0) return;

        // 0. Prepare Marking Scheme (Upload once)
        msFileUri = await prepareMarkingScheme();

        // 0.5. Build complete answer bank from MS
        await buildAnswerBank();

        // 1. Auto-Detect Subject (Or use override)
        const subjectId = await autoDetectSubject(imagePaths[0]);
        // const subjectId = NEW_DEFAULTS.subjectId; // User enforced this

        // 2. Build Tree for that Subject
        const mapString = await buildFullCurriculumMap(subjectId);

        // 3. Process All Pages (Start from 3rd page - index 2)
        console.log("Starting analysis from Page 3...");
        for (let i = 2; i < imagePaths.length; i++) {
            // Safety Delay for Quota (Free Tier requires ~30s+ break sometimes)
            if (i > 0) await new Promise(r => setTimeout(r, 35000));

            const result = await analyzePage(imagePaths[i], i, mapString);

            // Handle Metadata updates (if found on this page)
            // Handle Metadata updates (if found on this page)
            if (result && result.metadata) {
                if (result.metadata.exam) NEW_DEFAULTS.exam = result.metadata.exam;
                if (result.metadata.paper) {
                    let p = result.metadata.paper;
                    // Ensure "Paper X" format
                    if (Array.isArray(p)) {
                        p = p.map(val => val.toString().match(/^\d+$/) ? `Paper ${val}` : val);
                        NEW_DEFAULTS.paper = p; // Store as array, stringify later
                    } else if (typeof p === 'string' || typeof p === 'number') {
                        let pStr = p.toString();
                        if (/^\d+$/.test(pStr)) pStr = `Paper ${pStr}`;
                        NEW_DEFAULTS.paper = [pStr];
                    }
                }
                // We could also update year/month if needed
            }

            if (!result || !result.questions || result.questions.length === 0) continue;

            for (const q of result.questions) {
                await cropAndUpload(q, imagePaths[i]);
            }
        }
    } catch (e) { console.error("Fatal:", e); }
}

main();

async function generateVisualSolution(questionText, qNum, msPageUri) {
    const prompt = `
    You are an expert Math Tutor. 
    Can you look at the Marking Scheme (Image provided) for Question "${qNum}"?
    
    The Question is: "${questionText.replace(/<[^>]*>/g, '')}"
    
    TASK:
    Generate a BEAUTIFUL, DETAILED, STEP-BY-STEP solution in HTML.
    
    INSTRUCTIONS:
    1. Locate the answer for "${qNum}" in the Marking Scheme image.
    2. Write a full explanation of how to get that answer.
    3. If the marking scheme shows a diagram, describe it or use HTML to represent it if possible.
    4. Use proper HTML formatting <p>, <strong>, <ul>.
    5. MATH FORMATTING: Use LaTeX for equations inside $...$.
       - CRITICAL: Escape backslashes for JSON! Use \\\\ for a single backslash.
       - Example: "$A = \\\\pi r^2$"
    
    OUTPUT JSON (Valid JSON String):
    {
       "solution": "<p><strong>Step 1:</strong> Use formula $A = \\\\pi r^2$...</p>",
       "explanation": "Brief conceptual explanation..."
    }
    `;

    try {
        const result = await withRetry(() => model.generateContent({
            contents: [{ role: 'user', parts: [{ text: prompt }, { fileData: { fileUri: msPageUri, mimeType: "image/png" } }] }],
            generationConfig: { responseMimeType: "application/json" }
        }), 2, 5000); // Fewer retries, faster timeout

        let cleaned = repairJson(result.response.text());
        return JSON.parse(cleaned);
    } catch (e) {
        return null;
    }
}
