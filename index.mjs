import { GoogleGenAI } from "@google/genai";
import Groq from "groq-sdk";
import { EdgeTTS } from "node-edge-tts";
import * as fs from "node:fs";
import * as path from "node:path";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

// 1. Load .env file automatically
if (fs.existsSync(".env")) {
  const envContent = fs.readFileSync(".env", "utf-8");
  for (const line of envContent.split("\n")) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith("#") && trimmed.includes("=")) {
      const [key, ...rest] = trimmed.split("=");
      process.env[key.trim()] = rest.join("=").trim().replace(/^["']|["']$/g, "");
    }
  }
}

const geminiApiKey = process.env.GEMINI_API_KEY;
const groqApiKey = process.env.GROQ_API_KEY;

if (!geminiApiKey) {
  console.error("❌ Error: GEMINI_API_KEY is missing from .env or environment.");
  process.exit(1);
}

const ai = new GoogleGenAI({ apiKey: geminiApiKey });
const groq = groqApiKey ? new Groq({ apiKey: groqApiKey }) : null;
const MODEL_NAME = "gemini-3.5-flash-lite";

// 2. Language & Voice configuration (Clean text without Tashkeel)
const LANGUAGES = {
  "1": {
    code: "ar-EG",
    name: "Arabic (Egyptian Dialect - عامية مصرية)",
    provider: "groq",
    model: "canopylabs/orpheus-arabic-saudi",
    femaleVoice: "lulwa",
    maleVoice: "abdullah",
    styleGuide: `
Language: Egyptian Colloquial Arabic (اللهجة المصرية العامية الحية).
- DO NOT use Modern Standard Arabic (فصحى).
- DO NOT use Tashkeel (بدون تشكيل تماماً). Write plain, natural Egyptian text as commonly typed.
- Use natural Egyptian podcast banter: "يا نهار ابيض!", "بص بقى يا سيدي", "طب بذمتك؟", "يا راجل كبر مخك", "ايوة بالظبط كده!", "طب والعمل؟", "يا خبر ابيض!", "شوف يا فنان", "عارف ليه؟".
- Keep it witty, humorous, energetic, with realistic interruptions and laughter tags.
`,
  },
  "2": {
    code: "en-US",
    name: "English (US)",
    provider: "edgetts",
    femaleVoice: "en-US-JennyNeural",
    maleVoice: "en-US-GuyNeural",
    styleGuide: `
Language: English (US).
- Authentic, fast-paced, witty American podcast banter (NotebookLM Audio Overview style).
- Natural conversational hooks: "Wait, are you serious?", "Haha, exactly!", "Hold on a second...", "That blew my mind!", "Let's unpack that."
- Maintain strict natural English grammar and conversational syntax.
`,
  },
  "3": {
    code: "de-DE",
    name: "German (Deutsch)",
    provider: "edgetts",
    femaleVoice: "de-DE-KatjaNeural",
    maleVoice: "de-DE-ConradNeural",
    styleGuide: `
Language: German (Deutsch).
- Natural, modern German podcast dialogue with proper German syntax and idiom.
- Conversational reactions: "Echt jetzt?", "Warte mal kurz...", "Das ist ja der Wahnsinn!", "Ganz genau!", "Aber mal ehrlich...".
- Strict natural German grammar throughout.
`,
  },
  "4": {
    code: "fr-FR",
    name: "French (Français)",
    provider: "edgetts",
    femaleVoice: "fr-FR-DeniseNeural",
    maleVoice: "fr-FR-HenriNeural",
    styleGuide: `
Language: French (Français).
- Natural, expressive Parisian podcast dialogue with rich emotions and authentic French syntax.
- Conversational hooks: "Attends une seconde...", "Ah mais tellement !", "C'est un truc de fou !", "Tu rigoles ou quoi ?", "Exactement !".
- Strict natural French grammar throughout.
`,
  },
  "5": {
    code: "ja-JP",
    name: "Japanese (日本語)",
    provider: "edgetts",
    femaleVoice: "ja-JP-NanamiNeural",
    maleVoice: "ja-JP-KeitaNeural",
    styleGuide: `
Language: Japanese (日本語).
- Natural conversational Japanese with proper syntax, polite yet friendly podcast tone, and lively aizuchi (相槌).
- Reactions: 「えっ、本当ですか？」, 「なるほどね！笑」, 「あはは、確かに！」, 「ちょっと待ってください、それって...」.
- Strict natural Japanese grammar throughout.
`,
  },
};

// 3. DOUBLED Word counts per duration (while keeping duration labels identical)
const DURATIONS = {
  "1": {
    label: "5 mins",
    targetWords: 1400, // Doubled from 700
    acts: 2,
    turnsPerAct: "20-25 turns per act",
  },
  "2": {
    label: "15 mins",
    targetWords: 4200, // Doubled from 2100
    acts: 4,
    turnsPerAct: "25-30 turns per act",
  },
  "3": {
    label: "45 mins",
    targetWords: 12400, // Doubled from 6200
    acts: 10,
    turnsPerAct: "30-35 turns per act",
  },
};

// 4. Emotion prosody mapping for Edge-TTS
function getEdgeProsody(emotion) {
  const e = (emotion || "").toLowerCase();
  if (e.includes("excit") || e.includes("surpris") || e.includes("shock") || e.includes("حماس")) {
    return { rate: "+8%", pitch: "+4Hz" };
  }
  if (e.includes("laugh") || e.includes("amus") || e.includes("ضحك") || e.includes("هزار")) {
    return { rate: "+5%", pitch: "+3Hz" };
  }
  if (e.includes("thought") || e.includes("curious") || e.includes("تفكير")) {
    return { rate: "-4%", pitch: "-2Hz" };
  }
  return { rate: "+0%", pitch: "+0Hz" };
}

// 5. Chunk text safely for Groq Orpheus TTS
function splitTextIntoSafeChunks(text, maxLen = 190) {
  if (text.length <= maxLen) return [text];
  const parts = [];
  const sentences = text.split(/([.!؟?,\n]+)/);
  let current = "";

  for (let i = 0; i < sentences.length; i++) {
    const segment = sentences[i];
    if ((current + segment).length > maxLen) {
      if (current.trim()) parts.push(current.trim());
      current = segment;
    } else {
      current += segment;
    }
  }
  if (current.trim()) parts.push(current.trim());
  return parts.length > 0 ? parts : [text.slice(0, maxLen)];
}

// 6. Concatenate multiple WAV buffers cleanly
function concatenateWavBuffers(wavBuffers) {
  if (wavBuffers.length === 0) return Buffer.alloc(0);
  if (wavBuffers.length === 1) return wavBuffers[0];

  const firstHeader = wavBuffers[0].subarray(0, 44);
  const dataChunks = [];
  let totalDataLength = 0;

  for (const buf of wavBuffers) {
    if (buf.length > 44) {
      const data = buf.subarray(44);
      dataChunks.push(data);
      totalDataLength += data.length;
    }
  }

  const merged = Buffer.alloc(44 + totalDataLength);
  firstHeader.copy(merged, 0, 0, 44);
  merged.writeUInt32LE(36 + totalDataLength, 4);
  merged.writeUInt32LE(totalDataLength, 40);

  let offset = 44;
  for (const chunk of dataChunks) {
    chunk.copy(merged, offset);
    offset += chunk.length;
  }
  return merged;
}

// 7. Strip ID3 headers from Edge-TTS MP3 chunks
function stripId3Tag(buf) {
  if (buf.length > 10 && buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33) {
    const tagSize =
      ((buf[6] & 0x7f) << 21) |
      ((buf[7] & 0x7f) << 14) |
      ((buf[8] & 0x7f) << 7) |
      (buf[9] & 0x7f);
    const headerSize = 10 + tagSize;
    if (buf.length > headerSize) return buf.subarray(headerSize);
  }
  return buf;
}

// 8. Gemini Script Generator
async function callGemini(prompt, schema) {
  if (ai.interactions && typeof ai.interactions.create === "function") {
    try {
      const interaction = await ai.interactions.create({
        model: MODEL_NAME,
        input: prompt,
        response_format: {
          type: "text",
          mime_type: "application/json",
          schema: schema,
        },
      });
      if (interaction?.output_text) return JSON.parse(interaction.output_text);
    } catch {
      // Fallback below
    }
  }

  const response = await ai.models.generateContent({
    model: MODEL_NAME,
    contents: prompt,
    config: {
      responseMimeType: "application/json",
      responseSchema: schema,
    },
  });

  const raw = response.text || response.candidates?.[0]?.content?.parts?.[0]?.text;
  return JSON.parse(raw);
}

// 9. Main Controller
async function main() {
  console.log("===============================================================");
  console.log("🎙️   PODCAST STUDIO: HIGH-VOLUME SCRIPT & MULTI-LANGUAGE       🎙️");
  console.log("===============================================================\n");

  const rl = readline.createInterface({ input, output });

  const topic = await rl.question("📌 Enter podcast topic: ");

  console.log("\n🌐 Choose Language / Dialect:");
  console.log("  [1] Arabic (Egyptian Dialect - بدون تشكيل) -> Groq Orpheus API");
  console.log("  [2] English (US)                          -> Edge-TTS");
  console.log("  [3] German (Deutsch)                      -> Edge-TTS");
  console.log("  [4] French (Français)                     -> Edge-TTS");
  console.log("  [5] Japanese (日本語)                     -> Edge-TTS");
  const langChoice = (await rl.question("Select (1-5) [Default 1]: ")) || "1";
  const selectedLang = LANGUAGES[langChoice] || LANGUAGES["1"];

  console.log("\n⏱️  Choose Podcast Duration:");
  console.log("  [1] 5 minutes  (Expanded: ~1,400 words)");
  console.log("  [2] 15 minutes (Expanded: ~4,200 words)");
  console.log("  [3] 45 minutes (Expanded: ~12,400 words)");
  const durChoice = (await rl.question("Select (1-3) [Default 1]: ")) || "1";
  const selectedDuration = DURATIONS[durChoice] || DURATIONS["1"];

  rl.close();

  if (selectedLang.provider === "groq" && !groqApiKey) {
    console.error("\n❌ Error: Arabic requires GROQ_API_KEY in your .env file.");
    process.exit(1);
  }

  console.log(`\n🚀 Generating Episode: "${topic}"`);
  console.log(`🗣️  Language: ${selectedLang.name}`);
  console.log(`🎙️  Engine: ${selectedLang.provider.toUpperCase()}`);
  console.log(`⏱️  Duration: ${selectedDuration.label}`);
  console.log(`📝 Target Volume: ~${selectedDuration.targetWords} words (across ${selectedDuration.acts} sequential acts)\n`);

  const jsonSchema = {
    type: "object",
    properties: {
      podcastTitle: { type: "string" },
      topic: { type: "string" },
      dialogue: {
        type: "array",
        items: {
          type: "object",
          properties: {
            speaker: { type: "string", enum: ["man", "woman"] },
            emotion: { type: "string" },
            text: {
              type: "string",
              description: "The spoken dialogue turn in the selected language. Do not include tashkeel.",
            },
          },
          required: ["speaker", "emotion", "text"],
        },
      },
    },
    required: ["podcastTitle", "topic", "dialogue"],
  };

  let allDialogue = [];
  let episodeTitle = topic;
  const wordsPerAct = Math.round(selectedDuration.targetWords / selectedDuration.acts);

  for (let act = 1; act <= selectedDuration.acts; act++) {
    console.log(`✍️  Gemini (${MODEL_NAME}) is generating Act ${act} of ${selectedDuration.acts} (~${wordsPerAct} words)...`);

    const actObjective =
      act === 1
        ? "Opening segment: Hook listeners with passion, playful banter, introduce surprising facts and the central dilemma."
        : act === selectedDuration.acts
        ? "Final closing segment: Profound takeaways, future outlook, hilarious concluding thoughts, and warm sign-off."
        : `Progressive segment (Act ${act}): Deepen the conversation, debate counter-arguments, introduce fascinating examples and analogies.`;

    const previousContext =
      allDialogue.length > 0
        ? `The conversation previously paused on:\n${allDialogue.slice(-2).map((d) => `${d.speaker}: "${d.text}"`).join("\n")}\nContinue seamlessly from this exact point.`
        : "";

    const prompt = `
You are the showrunner for a two-host podcast episode between a Woman and a Man.
Topic: "${topic}".
Segment: Act ${act} of ${selectedDuration.acts}.
Target Volume for this act: ~${wordsPerAct} words (around ${selectedDuration.turnsPerAct}).

CRITICAL LANGUAGE REQUIREMENT:
- You MUST write the ENTIRE dialogue strictly in: ${selectedLang.name}.
- Do NOT output in Arabic unless Arabic was explicitly chosen!
- Do NOT add Tashkeel (no diacritics/harakat). Keep the text natural, clean, and conversational.

Language & Syntax Guidelines:
${selectedLang.styleGuide}

Host Personalities:
- Woman: Sharp, intuitive, humorous, asks challenging questions, reacts expressively.
- Man: Energetic, explains concepts with vivid metaphors, laughs, challenges points.

Segment Purpose:
${actObjective}

${previousContext}

Generate extensive, engaging back-and-forth dialogue adhering to the JSON schema.
`;

    const result = await callGemini(prompt, jsonSchema);
    if (result.podcastTitle) episodeTitle = result.podcastTitle;
    if (Array.isArray(result.dialogue)) {
      allDialogue = allDialogue.concat(result.dialogue);
    }
  }

  // 10. Save JSON output
  const outputDir = path.resolve("output");
  const tempDir = path.join(outputDir, "temp_chunks");
  fs.mkdirSync(tempDir, { recursive: true });

  const finalJson = {
    podcastTitle: episodeTitle,
    topic,
    languageCode: selectedLang.code,
    languageName: selectedLang.name,
    targetDuration: selectedDuration.label,
    totalDialogueTurns: allDialogue.length,
    dialogue: allDialogue,
  };

  const jsonFilePath = path.join(outputDir, "output.json");
  fs.writeFileSync(jsonFilePath, JSON.stringify(finalJson, null, 2), "utf-8");
  console.log(`\n💾 Saved dialogue script to: ${jsonFilePath}`);

  // 11. Audio synthesis
  console.log(`\n🎧 Synthesizing ${allDialogue.length} dialogue turns...`);
  const audioBuffers = [];

  for (let i = 0; i < allDialogue.length; i++) {
    const item = allDialogue[i];
    const isWoman = item.speaker.toLowerCase() === "woman";
    const voice = isWoman ? selectedLang.femaleVoice : selectedLang.maleVoice;
    const speakerLabel = isWoman ? "👩 Woman" : "👨 Man";

    process.stdout.write(
      `   [${i + 1}/${allDialogue.length}] ${speakerLabel} (${item.emotion}) [${selectedLang.provider}] -> `
    );

    try {
      if (selectedLang.provider === "groq") {
        // Groq Orpheus API for Arabic
        const subChunks = splitTextIntoSafeChunks(item.text, 190);
        const subBuffers = [];

        for (const sub of subChunks) {
          const response = await groq.audio.speech.create({
            model: selectedLang.model,
            voice: voice,
            input: sub,
            response_format: "wav",
          });
          const arrayBuffer = await response.arrayBuffer();
          subBuffers.push(Buffer.from(arrayBuffer));
        }

        const turnWav = concatenateWavBuffers(subBuffers);
        audioBuffers.push(turnWav);
        console.log(`✅`);
      } else {
        // Edge-TTS for English, German, French, Japanese
        const prosody = getEdgeProsody(item.emotion);
        const tempChunk = path.join(tempDir, `chunk_${String(i).padStart(4, "0")}.mp3`);

        const tts = new EdgeTTS({
          voice: voice,
          lang: selectedLang.code,
          rate: prosody.rate,
          pitch: prosody.pitch,
          outputFormat: "audio-24khz-48kbitrate-mono-mp3",
        });

        await tts.ttsPromise(item.text, tempChunk);
        const chunkBuf = fs.readFileSync(tempChunk);
        audioBuffers.push(i === 0 ? chunkBuf : stripId3Tag(chunkBuf));
        console.log(`✅`);
      }
    } catch (err) {
      console.log(`❌ ${err.message}`);
    }
  }

  // 12. Save final combined audio
  const isGroq = selectedLang.provider === "groq";
  const finalAudioPath = path.join(outputDir, isGroq ? "output.wav" : "output.mp3");

  console.log(`\n🔄 Merging audio segments into ${finalAudioPath}...`);
  const finalBuffer = isGroq ? concatenateWavBuffers(audioBuffers) : Buffer.concat(audioBuffers);
  fs.writeFileSync(finalAudioPath, finalBuffer);

  if (isGroq) {
    fs.copyFileSync(finalAudioPath, path.join(outputDir, "output.mp3"));
  }

  fs.rmSync(tempDir, { recursive: true, force: true });

  console.log("\n===============================================================");
  console.log(`🎉 SUCCESS! Audio Overview Podcast Ready!`);
  console.log(`📄 JSON Script: ${jsonFilePath}`);
  console.log(`🎵 Audio File:  ${finalAudioPath}`);
  console.log(`🎙️  Total Exchanges: ${allDialogue.length}`);
  console.log("===============================================================\n");
}

main().catch(console.error);