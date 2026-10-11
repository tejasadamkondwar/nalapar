import { medicines, type Medicine } from "../../data/medicines";
import { additionalMedicines } from "../../data/medibot-additional-medicines";
import { GET as searchDataset } from "../medicines/search/route";
import { lookupPartnerPrices, type PartnerPriceOffer } from "../../lib/partner-prices";

const REQUIRED_DISCLAIMER =
  "MediBot is an informational tool. It does not diagnose medical conditions or prescribe medications. Users must always consult a qualified medical professional before taking any medication.";
const PRESCRIPTION_WARNING =
  "This medication requires a valid prescription. Please consult your doctor.";
const NO_PERSONALIZED_TREATMENT =
  "I can share general health information, but I cannot diagnose a condition or recommend a specific medicine or dose. The right care depends on the person and situation. Please consult a qualified doctor or pharmacist for individual advice.";
const SERIOUS_SYMPTOMS = [
  "chest pain", "difficulty breathing", "shortness of breath", "can't breathe",
  "cannot breathe", "unconscious", "seizure", "severe bleeding", "overdose",
  "poisoning", "anaphylaxis", "stroke", "suicidal",
];

type Schedule = Medicine["schedule"];
type DetectedMedication = {
  name: string;
  prescription_classification: Schedule;
  prescription_status_verified: boolean;
  active_composition: string | null;
  category: string | null;
  product_type: string | null;
  manufacturer: string | null;
  pack_size: string | null;
  reference_price_inr: number | null;
  reference_price_source: string | null;
  dosage_form: string | null;
};

type ApiReply = {
  answer: string;
  intent: string;
  safety_guard: {
    blocked: boolean;
    reason: "none" | "known_schedule_h" | "restricted_ingredient_alias" | "prescription_status_unverified" | "personalized_treatment" | "serious_symptom";
    detected_medications: string[];
    message: string | null;
  };
  detected_medication: DetectedMedication | null;
  substitutes: Array<{
    name: string;
    active_ingredients: string[];
    strength: string;
    dosage_form: string;
    composition_verified: true;
  }>;
  partner_price_comparison: PartnerPriceOffer[];
  price_data_status: { status: string; message: string };
  disclaimer: string;
  sources: Record<string, { available: boolean; records?: number; file?: string; error?: string }> | null;
  /** Data-backed matches made available to the local chat catalogue. */
  catalog_matches: Medicine[];
};

const curated: Medicine[] = [...medicines, ...additionalMedicines];

// Conservative aliases derived from the curated Schedule H examples. This is
// not an authoritative regulatory list; review it against current official
// schedules. An ingredient mention outside an antibiotic-resistance question
// is routed to the exact warning to avoid revealing purchase/detail pathways.
const RESTRICTED_INGREDIENT_ALIASES = [...new Set(
  [
    ...curated.filter((item) => item.schedule === "Schedule H").flatMap((item) => item.activeIngredients),
    "Amoxycillin", "Clavulanate", "Ciprofloxacin", "Metronidazole", "Doxycycline",
    "Levofloxacin", "Cefuroxime", "Cefpodoxime", "Prednisolone", "Methylprednisolone",
    "Fluconazole", "Itraconazole", "Amlodipine", "Losartan", "Atorvastatin",
  ].map((item) => item.trim()).filter((item) => item.length >= 5)
)];

function restrictedIngredientMention(query: string): string | null {
  const lower = query.toLowerCase();
  // Preserve general educational queries about antibiotic resistance.
  if (/\b(resistance|resistant)\b/.test(lower) && /\b(antibiotic|antibiotics|bacteria|bacterial)\b/.test(lower)) return null;
  const match = RESTRICTED_INGREDIENT_ALIASES.find((ingredient) => containsWholePhrase(query, ingredient));
  return match ?? null;
}

function normalizePhrase(input: string): string {
  return input.toLowerCase().normalize("NFKC").replace(/(\d+(?:\.\d+)?)\s+(mg|mcg|μg|g|gm|ml|iu)\b/gi, "$1$2").replace(/[^a-z0-9.]+/g, " ").replace(/\s+/g, " ").trim();
}

function containsWholePhrase(haystack: string, phrase: string): boolean {
  const text = ` ${normalizePhrase(haystack)} `;
  const target = ` ${normalizePhrase(phrase)} `;
  return target.trim().length > 0 && text.includes(target);
}

function brandSeed(name: string): string {
  const normalized = normalizePhrase(name);
  const tokens = normalized.split(" ").filter(Boolean);
  const firstStrength = tokens.findIndex((token) => /^\d/.test(token));
  return (firstStrength < 0 ? tokens : tokens.slice(0, firstStrength)).join(" ");
}

function medicineIsMentioned(query: string, medicineName: string): boolean {
  if (containsWholePhrase(query, medicineName)) return true;
  const nameTokens = normalizePhrase(medicineName).split(" ").filter(Boolean);
  const firstStrength = nameTokens.findIndex((token) => /^\d/.test(token));
  const seed = brandSeed(medicineName);
  // Products often appear without a trailing descriptor word. Match the exact
  // name prefix through strength (e.g. "Augmentin 625") when provided.
  if (firstStrength >= 0) {
    const exactProductPrefix = nameTokens.slice(0, firstStrength + 1).join(" ");
    if (containsWholePhrase(query, exactProductPrefix)) return true;
    // If only the brand is given, still detect it. But when the user specified
    // a different known strength of that same brand, don't match this variant.
    if (seed.length < 4 || !containsWholePhrase(query, seed)) return false;
    const differentSpecificVariant = curated.some((other) => {
      if (other.name === medicineName || brandSeed(other.name) !== seed) return false;
      const otherTokens = normalizePhrase(other.name).split(" ").filter(Boolean);
      const otherStrength = otherTokens.findIndex((token) => /^\d/.test(token));
      if (otherStrength < 0) return false;
      const otherPrefix = otherTokens.slice(0, otherStrength + 1).join(" ");
      return containsWholePhrase(query, otherPrefix);
    });
    return !differentSpecificVariant;
  }
  return seed.length >= 4 && containsWholePhrase(query, seed);
}

function explicitCuratedMentions(query: string): Medicine[] {
  return curated.filter((med) => medicineIsMentioned(query, med.name));
}

function isFollowUp(query: string): boolean {
  const q = normalizePhrase(query);
  return /\b(it|its|this|that|same|those|these)\b/.test(q) ||
    /\b(what about|how about|its price|price of it|cheaper alternative)\b/.test(q);
}

function isTreatmentRequest(query: string): boolean {
  const q = query.toLowerCase();
  const patterns = [
    "what medicine should", "which medicine should", "what should i take", "what can i take",
    "which tablet should", "what tablet should", "recommend a medicine", "recommend me a medicine",
    "suggest a medicine", "suggest me a medicine", "what medicine is used for", "which medicine is used for",
    "what medicine can i take", "what tablet can i take", "dosage of", "dose of", "how many tablets",
    "how many mg should", "should i start", "should i stop", "prescribe", "treat my", "cure my",
  ];
  return patterns.some((pattern) => q.includes(pattern)) || /\b(?:recommend|prescribe|suggest)\w*\b/i.test(q);
}

function isPriceIntent(query: string): boolean {
  return /\b(price|prices|cost|cheapest|cheaper price|mrp|how much|availability|in stock|buy|purchase)\b/i.test(query);
}
function isAlternativeIntent(query: string): boolean {
  return /\b(alternative|alternatives|substitute|substitutes|equivalent|cheaper alternative)\b/i.test(query);
}
function isComparisonIntent(query: string): boolean {
  return /\b(compare|comparison|versus|vs\.?|difference between)\b/i.test(query);
}

type ComparisonSides = { left: string; right: string };

function parseComparisonSides(query: string): ComparisonSides | null {
  const q = query.trim().replace(/[?!.]+$/, "").trim();
  const patterns = [
    /^(?:(?:please\s+)?compare(?:\s+the)?(?:\s+prices?)?(?:\s+of)?|comparison\s+of|difference\s+between)\s+(.+?)\s+(?:and|with|to|versus|vs\.?)\s+(.+)$/i,
    /^(.+?)\s+(?:versus|vs\.?)\s+(.+)$/i,
  ];
  for (const pattern of patterns) {
    const match = q.match(pattern);
    if (match?.[1]?.trim() && match?.[2]?.trim()) {
      return { left: match[1].trim(), right: match[2].trim() };
    }
  }
  return null;
}
function isHealthEducationQuery(query: string): boolean {
  const q = normalizePhrase(query);
  const topics = [
    "fever", "headache", "migraine", "common cold", "cold", "cough", "sore throat", "allergy", "stroke",
    "dehydration", "nausea", "vomiting", "diarrhea", "constipation", "acidity", "heartburn",
    "back pain", "toothache", "earache", "rash", "dizziness", "sleep", "blood pressure",
    "diabetes", "prescription", "side effect", "active ingredient", "antibiotic resistance",
    "antihistamine", "painkiller", "otc", "hydration", "medicine storage", "expired medicine",
  ];
  const hasTopic = topics.some((topic) => q.includes(topic));
  if (!hasTopic || isTreatmentRequest(query)) return false;
  const educationLead = /^(what is|what are|what's|define|explain|meaning of|what causes|causes of|symptoms of|why do|how does|tell me about|can you explain|what should i know about)\b/.test(q);
  if (educationLead) return true;
  // "fever" and "fever in a child" are symptom questions even without
  // "what is". They must not be captured by brands such as Fever-X unless
  // the user also names a strength, dosage form, or extra brand word.
  const tokens = q.split(" ").filter(Boolean);
  const dosageForms = new Set(["tablet", "tablets", "tab", "tabs", "capsule", "capsules", "syrup", "suspension", "injection", "solution", "drops", "cream", "ointment", "gel", "spray", "powder"]);
  if (tokens.some((token) => /^\d/.test(token) || dosageForms.has(token))) return false;
  const fillers = new Set(["a", "an", "the", "is", "are", "of", "in", "on", "for", "with", "and", "or", "my", "me", "i", "to", "about", "please", "child", "children", "baby", "infant", "kid", "kids", "adult", "mild", "high", "low", "severe", "bad", "little"]);
  return tokens.every((token) => topics.includes(token) || fillers.has(token));
}

function healthEducationReply(query: string): string {
  const q = query.toLowerCase();
  if (q.includes("fever")) return "Fever is a temporary rise in body temperature and can occur with infections or other conditions. A high, persistent, recurring fever or fever in a very young infant needs prompt professional assessment. This is general information, not a diagnosis.";
  if (q.includes("headache") || q.includes("migraine")) return "A headache is pain in the head or upper neck. Causes vary and may include tension, illness, dehydration, sleep disruption, or migraine. Sudden severe headache, new neurological symptoms, confusion, or headache after a serious injury requires urgent medical assessment.";
  if (q.includes("common cold") || /\bcold\b/.test(q)) return "The common cold is usually a viral infection of the upper respiratory tract. Symptoms can include a runny or blocked nose, sneezing, sore throat, and cough. Seek professional advice for breathing difficulty, severe or persistent symptoms, or symptoms in a vulnerable person.";
  if (q.includes("cough")) return "A cough is a reflex that helps clear irritants or mucus from the airways. It can have many causes, including respiratory infections and allergies. Seek urgent care for significant breathing difficulty, blue lips, coughing blood, or severe chest pain.";
  if (q.includes("sore throat")) return "A sore throat is irritation or pain in the throat and can occur with viral infections, dryness, or other causes. Difficulty breathing or swallowing saliva, severe swelling, or rapidly worsening symptoms needs urgent care.";
  if (q.includes("allerg")) return "An allergy is an immune response to a substance that is usually harmless to most people. Symptoms vary. Trouble breathing, swelling of the tongue or throat, or collapse may indicate a severe reaction and requires emergency help.";
  if (q.includes("dehydration") || q.includes("hydration")) return "Dehydration happens when the body loses more fluid than it takes in. Signs can include thirst, dry mouth, darker or reduced urine, or dizziness. Confusion, fainting, inability to keep fluids down, or signs in a small child need prompt care.";
  if (q.includes("nausea") || q.includes("vomit")) return "Nausea is the feeling of wanting to vomit, while vomiting is forceful emptying of stomach contents. Causes vary. Seek prompt care for blood in vomit, severe abdominal pain, confusion, dehydration, or persistent vomiting.";
  if (q.includes("diarrhea")) return "Diarrhea means passing loose or watery stools more often than usual. The main concern can be dehydration. Seek care for blood in stool, severe pain, dehydration, high fever, or symptoms that persist, especially for children or older adults.";
  if (q.includes("constipation")) return "Constipation usually means infrequent bowel movements or stools that are hard or difficult to pass. Causes vary. Severe abdominal pain, vomiting, marked swelling, or inability to pass gas with constipation needs prompt medical assessment.";
  if (q.includes("acidity") || q.includes("heartburn")) return "Acidity or heartburn can feel like burning discomfort in the chest or upper abdomen, but chest discomfort can have serious causes. New or severe chest pain, sweating, breathlessness, or pain spreading to the arm or jaw warrants emergency assessment.";
  if (q.includes("back pain")) return "Back pain has many causes, from muscle strain to other conditions. New weakness, numbness around the groin, loss of bladder or bowel control, fever with severe back pain, or pain after major injury needs urgent evaluation.";
  if (q.includes("toothache")) return "Toothache can result from cavities, gum problems, infection, or injury. Facial swelling, fever, difficulty swallowing or breathing, or rapidly worsening swelling requires urgent dental or medical care.";
  if (q.includes("earache")) return "Earache can arise from infection, pressure, wax, or other causes. Seek care for severe pain, discharge, sudden hearing loss, swelling around the ear, or symptoms with significant fever.";
  if (q.includes("rash")) return "A rash is a visible change in skin colour, texture, or sensation and can have many causes. A rash with breathing difficulty, facial or tongue swelling, purple spots that do not fade when pressed, or severe illness needs urgent attention.";
  if (q.includes("dizziness")) return "Dizziness can mean light-headedness, imbalance, or a spinning sensation, and has many possible causes. Seek emergency help for dizziness with chest pain, fainting, trouble speaking, new weakness, or severe sudden headache.";
  if (q.includes("stroke")) return "A stroke is a medical emergency in which blood flow to part of the brain is interrupted or bleeding occurs. Sudden face drooping, arm weakness, speech trouble, new vision/balance problems, or a severe sudden headache require emergency services immediately.";
  if (q.includes("blood pressure")) return "Blood pressure is the force of blood against artery walls, measured with two numbers. One reading may not establish a diagnosis. Very high readings with chest pain, breathlessness, confusion, or neurological symptoms need urgent medical assessment.";
  if (q.includes("diabetes")) return "Diabetes is a condition involving elevated blood glucose over time. Diagnosis and management require appropriate clinical assessment and monitoring. Do not start, stop, or change diabetes medicines based only on this information.";
  if (q.includes("prescription")) return "A prescription is an instruction from an authorized healthcare professional for a medicine or treatment. Prescription requirements vary by medicine and local rules; do not use prescription medicines without the required valid prescription.";
  if (q.includes("side effect")) return "A side effect is an unwanted or unintended effect of a medicine. Read the product information and ask a pharmacist or clinician about concerns. Seek emergency help for difficulty breathing, facial/throat swelling, collapse, or another severe reaction.";
  if (q.includes("active ingredient")) return "An active ingredient is the component responsible for a medicine's intended medicinal effect. Two brands should not be assumed equivalent unless their active ingredients, strength, dosage form, and relevant product details are verified.";
  if (q.includes("antibiotic resistance")) return "Antibiotic resistance occurs when bacteria evolve so antibiotics become less effective against them. Antibiotics do not treat viral infections such as most colds. Use antibiotics only as directed by a qualified professional.";
  if (q.includes("antihistamine")) return "Antihistamines reduce the effects of histamine and are used in some allergy-related conditions. They differ in sedation, interactions, and suitability; ask a pharmacist or clinician before using one.";
  if (q.includes("painkiller")) return "Pain relievers differ in their ingredients, risks, interactions, and suitability for different people. MediBot cannot choose a pain medicine or dose for you; a pharmacist or clinician can advise based on your situation.";
  if (/\botc\b/.test(q)) return "OTC means over the counter. Local rules and the specific product determine whether a medicine can be supplied without a prescription. Read the label and ask a pharmacist if unsure.";
  return "I can share general health information, but this answer is not a diagnosis or treatment plan. Please consult a qualified healthcare professional for personal advice.";
}

function detected(med: Medicine): DetectedMedication {
  return {
    name: med.name,
    prescription_classification: med.schedule,
    prescription_status_verified: med.schedule !== "Unverified",
    active_composition: med.composition || med.datasetComposition || null,
    category: med.category || null,
    product_type: med.datasetType || null,
    manufacturer: med.manufacturer || null,
    pack_size: med.packSize || null,
    reference_price_inr: med.datasetPrice ?? (med.mrp > 0 ? med.mrp : null),
    reference_price_source: med.datasetPrice != null ? (med.datasetSource ?? "Dataset reference price; not a live quote") : med.mrp > 0 ? "Curated prototype catalogue MRP; not a live quote" : null,
    dosage_form: med.dosageForm || null,
  };
}

function identicalComposition(a: Medicine, b: Medicine): boolean {
  if (!a.compositionVerified || !b.compositionVerified) return false;
  if (a.schedule !== "OTC" || b.schedule !== "OTC") return false;
  if (!a.activeIngredients.length || a.activeIngredients.length !== b.activeIngredients.length) return false;
  const normalizeIngredient = (v: string) => v.toLowerCase().replace(/[^a-z0-9]+/g, "").trim();
  const left = a.activeIngredients.map(normalizeIngredient).sort();
  const right = b.activeIngredients.map(normalizeIngredient).sort();
  return left.every((ingredient, i) => ingredient === right[i]) &&
    normalizePhrase(a.strength) === normalizePhrase(b.strength) &&
    normalizePhrase(a.dosageForm) === normalizePhrase(b.dosageForm);
}

async function datasetSearch(query: string): Promise<{ medicines: Medicine[]; sources: ApiReply["sources"] }> {
  const url = new URL("http://localhost/api/medicines/search");
  url.searchParams.set("q", query);
  const response = await searchDataset(new Request(url.toString()));
  if (!response.ok) return { medicines: [], sources: null };
  const payload = await response.json() as { medicines?: Medicine[]; sources?: ApiReply["sources"] };
  return { medicines: Array.isArray(payload.medicines) ? payload.medicines : [], sources: payload.sources ?? null };
}

async function resolveComparisonMedicine(side: string): Promise<Medicine | null> {
  const curatedMatches = curated.filter((item) => medicineIsMentioned(side, item.name));
  const exactCurated = curatedMatches.find((item) => normalizePhrase(item.name) === normalizePhrase(side));
  if (exactCurated) return exactCurated;
  if (curatedMatches.length === 1) return curatedMatches[0];
  if (curatedMatches.length > 1) return null;

  const result = await datasetSearch(side);
  const exactDataset = result.medicines.find((item) =>
    containsWholePhrase(side, item.name) || containsWholePhrase(item.name, side)
  );
  return exactDataset ?? null;
}

function emptyReply(overrides: Partial<ApiReply> = {}): ApiReply {
  return {
    answer: "",
    intent: "unknown",
    safety_guard: { blocked: false, reason: "none", detected_medications: [], message: null },
    detected_medication: null,
    substitutes: [],
    partner_price_comparison: [],
    price_data_status: { status: "not_requested", message: "No live pharmacy price query was requested." },
    disclaimer: REQUIRED_DISCLAIMER,
    sources: null,
    catalog_matches: [],
    ...overrides,
  };
}

export async function POST(request: Request) {
  let body: { query?: unknown; contextMedicineName?: unknown };
  try {
    body = await request.json() as { query?: unknown; contextMedicineName?: unknown };
  } catch {
    return Response.json({ ...emptyReply({ answer: "Body must be valid JSON." }), error: "Body must be valid JSON." }, { status: 400 });
  }

  const query = typeof body.query === "string" ? body.query.trim().slice(0, 600) : "";
  const context = typeof body.contextMedicineName === "string" ? body.contextMedicineName.trim().slice(0, 250) : "";
  if (!query) return Response.json({ ...emptyReply({ answer: "Please enter a question." }), error: "query is required" }, { status: 400 });

  const explicit = explicitCuratedMentions(query);
  const restricted = explicit.filter((med) => med.schedule === "Schedule H");
  const contextMed = context ? curated.find((med) => normalizePhrase(med.name) === normalizePhrase(context)) : undefined;
  const contextIsRestricted = Boolean(contextMed && contextMed.schedule === "Schedule H" && isFollowUp(query));
  const restrictedDetected = [...new Map([...restricted, ...(contextIsRestricted && contextMed ? [contextMed] : [])].map((med) => [med.name, med])).values()];

  // Highest-priority hard gate: no price, substitution, composition, use or other
  // details are returned for an explicitly identified Schedule H medicine.
  if (restrictedDetected.length > 0) {
    const med = restrictedDetected[0];
    return Response.json(emptyReply({
      answer: PRESCRIPTION_WARNING,
      intent: "restricted_drug_block",
      safety_guard: { blocked: true, reason: "known_schedule_h", detected_medications: restrictedDetected.map((item) => item.name), message: PRESCRIPTION_WARNING },
      detected_medication: { ...detected(med), active_composition: null, category: null, product_type: null, manufacturer: null, pack_size: null, reference_price_inr: null, reference_price_source: null, dosage_form: null },
      price_data_status: { status: "blocked", message: "Price comparison is blocked for a known Schedule H medicine." },
    }));
  }

  const ingredientAlias = restrictedIngredientMention(query);
  if (ingredientAlias) {
    return Response.json(emptyReply({
      answer: PRESCRIPTION_WARNING,
      intent: "restricted_drug_block",
      safety_guard: { blocked: true, reason: "restricted_ingredient_alias", detected_medications: [ingredientAlias], message: PRESCRIPTION_WARNING },
      detected_medication: {
        name: ingredientAlias,
        prescription_classification: "Unverified",
        prescription_status_verified: false,
        active_composition: null,
        category: null,
        product_type: null,
        manufacturer: null,
        pack_size: null,
        reference_price_inr: null,
        reference_price_source: null,
        dosage_form: null,
      },
      price_data_status: { status: "blocked", message: "A conservative restricted-ingredient alias guard was triggered; verify the exact product/classification with a pharmacist." },
    }));
  }

  const seriousMention = SERIOUS_SYMPTOMS.some((fragment) => query.toLowerCase().includes(fragment));
  const personalSymptom = /\b(i have|i am having|i'm having|i feel|i am experiencing|my symptoms|can't breathe|cannot breathe|overdose|poisoning)\b/i.test(query);
  if (seriousMention && (personalSymptom || isTreatmentRequest(query))) {
    const urgentMessage = "Some symptoms can be serious, and I can't assess them here. Please contact local emergency services or seek prompt professional medical care.";
    return Response.json(emptyReply({
      answer: `${urgentMessage}\n\n${REQUIRED_DISCLAIMER}`,
      intent: "serious_symptom",
      safety_guard: { blocked: true, reason: "serious_symptom", detected_medications: explicit.map((med) => med.name), message: "Urgent professional assessment recommended." },
    }));
  }

  if (isTreatmentRequest(query)) {
    return Response.json(emptyReply({
      answer: `${NO_PERSONALIZED_TREATMENT}\n\n${REQUIRED_DISCLAIMER}`,
      intent: "personalized_treatment_request",
      safety_guard: { blocked: true, reason: "personalized_treatment", detected_medications: explicit.map((med) => med.name), message: NO_PERSONALIZED_TREATMENT },
    }));
  }

  if (isHealthEducationQuery(query)) {
    return Response.json(emptyReply({ answer: `${healthEducationReply(query)}\n\n${REQUIRED_DISCLAIMER}`, intent: "health_education" }));
  }

  if (/^(hi|hello|hey|hiya|namaste|good morning|good afternoon|good evening)[!. ]*$/i.test(query)) {
    return Response.json(emptyReply({ answer: "Hello! I'm MediBot, a health information assistant built by Team DOOMSDAY. I can answer general health-education questions and look up medicine catalogue records. I do not diagnose or prescribe.\n\n" + REQUIRED_DISCLAIMER, intent: "conversation" }));
  }

  const localKnown = explicit[0];
  const data = await datasetSearch(query);
  const usesContext = Boolean(context && isFollowUp(query));
  const contextFromCurated = usesContext ? curated.find((med) => normalizePhrase(med.name) === normalizePhrase(context)) : undefined;
  const detectedMed = localKnown ?? contextFromCurated ?? data.medicines.find((med) => containsWholePhrase(query, med.name)) ?? data.medicines[0] ?? null;
  const priceIntent = isPriceIntent(query);
  const alternativeIntent = isAlternativeIntent(query);
  const comparisonIntent = isComparisonIntent(query);
  const comparisonSides = comparisonIntent ? parseComparisonSides(query) : null;

  if (comparisonSides) {
    const [left, right] = await Promise.all([
      resolveComparisonMedicine(comparisonSides.left),
      resolveComparisonMedicine(comparisonSides.right),
    ]);

    if (!left || !right || normalizePhrase(left.name) === normalizePhrase(right.name)) {
      return Response.json(emptyReply({
        answer: `I couldn't identify two distinct medicines from the catalogue. Please use exact product names, for example, “Compare Crocin 650 and Dolo 650”.\n\n${REQUIRED_DISCLAIMER}`,
        intent: "medicine_comparison_needs_two_names",
        sources: data.sources,
        catalog_matches: data.medicines,
      }));
    }

    const pair = [left, right];
    const restrictedSide = pair.find((item) => item.schedule === "Schedule H");
    if (restrictedSide) {
      return Response.json(emptyReply({
        answer: PRESCRIPTION_WARNING,
        intent: "restricted_drug_block",
        safety_guard: { blocked: true, reason: "known_schedule_h", detected_medications: [restrictedSide.name], message: PRESCRIPTION_WARNING },
        detected_medication: { ...detected(restrictedSide), active_composition: null, category: null, product_type: null, manufacturer: null, pack_size: null, reference_price_inr: null, reference_price_source: null, dosage_form: null },
        price_data_status: { status: "blocked", message: "Comparison is blocked because one listed medicine is marked Schedule H." },
      }));
    }
    if (pair.some((item) => item.schedule !== "OTC")) {
      const names = pair.filter((item) => item.schedule !== "OTC").map((item) => item.name);
      return Response.json(emptyReply({
        answer: `I cannot compare purchase options because the prescription status of ${names.join(", ")} is not verified. Please check the exact pack with a qualified pharmacist.\n\n${REQUIRED_DISCLAIMER}`,
        intent: "comparison_blocked_unverified",
        safety_guard: { blocked: true, reason: "prescription_status_unverified", detected_medications: names, message: "At least one medicine has an unverified prescription classification." },
        detected_medication: detected(left),
        catalog_matches: data.medicines,
        price_data_status: { status: "blocked_unverified_classification", message: "No purchase comparison returned for unverified medicine classification." },
      }));
    }

    if (priceIntent) {
      const [leftPrices, rightPrices] = await Promise.all([
        lookupPartnerPrices({ medicineName: left.name, composition: left.composition || left.datasetComposition, strength: left.strength, dosageForm: left.dosageForm, packSize: left.packSize }),
        lookupPartnerPrices({ medicineName: right.name, composition: right.composition || right.datasetComposition, strength: right.strength, dosageForm: right.dosageForm, packSize: right.packSize }),
      ]);
      const offers = [...leftPrices.offers, ...rightPrices.offers];
      const status = offers.length ? "live" : (leftPrices.status === rightPrices.status ? leftPrices.status : "not_available");
      const quoteLines = offers.length
        ? offers.map((offer) => `${offer.product_name} — ${offer.pharmacy}: ₹${offer.price} / ${offer.pack_size} (${offer.in_stock ? "in stock" : "out of stock"}; updated ${offer.updated_at})`).join("\n")
        : `${leftPrices.message} ${rightPrices.message}`;
      return Response.json(emptyReply({
        answer: `Price comparison for ${left.name} vs ${right.name}:\n${quoteLines}\n\nCompare only matching strengths and pack sizes. No live offers means no price or savings estimate is made.\n\n${REQUIRED_DISCLAIMER}`,
        intent: "price_comparison",
        detected_medication: detected(left),
        partner_price_comparison: offers,
        price_data_status: { status, message: offers.length ? "Live quotes returned by the configured partner feed; compare like-for-like packs and checkout totals." : `${leftPrices.message} ${rightPrices.message}` },
        sources: data.sources,
        catalog_matches: [...new Map([...data.medicines, left, right].map((item) => [normalizePhrase(item.name), item])).values()],
      }));
    }

    const describe = (item: Medicine) => [
      `Medicine: ${item.name}`,
      `Composition: ${item.composition || item.datasetComposition || "Not verified in the matched record"}`,
      `Strength: ${item.strength || "Not listed"}`,
      `Dosage form: ${item.dosageForm || "Not listed"}`,
      `Manufacturer: ${item.manufacturer || "Not listed"}`,
      `Reference price: ${item.datasetPrice != null ? `₹${item.datasetPrice} (dataset reference only)` : item.mrp > 0 ? `₹${item.mrp} (catalogue reference only)` : "Not available"}`,
    ].join("\n");
    return Response.json(emptyReply({
      answer: `Factual catalogue comparison\n\n${describe(left)}\n\n${describe(right)}\n\nThis comparison does not determine which medicine is right for a person. Confirm the exact pack and suitability with a qualified doctor or pharmacist.\n\n${REQUIRED_DISCLAIMER}`,
      intent: "medicine_comparison",
      detected_medication: detected(left),
      sources: data.sources,
      catalog_matches: [...new Map([...data.medicines, left, right].map((item) => [normalizePhrase(item.name), item])).values()],
    }));
  }

  if (!detectedMed) {
    return Response.json(emptyReply({
      answer: "I couldn't identify a medicine from the available catalogue. You can ask a general health-education question or provide the exact product name shown on its pack.\n\n" + REQUIRED_DISCLAIMER,
      intent: "unknown_medicine",
      sources: data.sources,
      catalog_matches: data.medicines,
      price_data_status: priceIntent
        ? { status: "not_available", message: "No matched medicine; no price was invented." }
        : { status: "not_requested", message: "No live pharmacy price query was requested." },
    }));
  }

  // Dataset-only records are informational references, not automatically OTC.
  if (detectedMed.schedule === "Unverified" && (priceIntent || alternativeIntent || comparisonIntent)) {
    return Response.json(emptyReply({
      answer: "This medicine's prescription status and product identity are not verified in MediBot. I can't provide a purchase comparison or substitute recommendation for this entry. Please confirm the exact pack and prescription status with a qualified pharmacist.\n\n" + REQUIRED_DISCLAIMER,
      intent: alternativeIntent ? "alternatives_blocked_unverified" : priceIntent ? "price_blocked_unverified" : "comparison_blocked_unverified",
      safety_guard: { blocked: true, reason: "prescription_status_unverified", detected_medications: [detectedMed.name], message: "Unverified medicine: purchase-related comparison and substitutions are not available." },
      detected_medication: detected(detectedMed),
      sources: data.sources,
      catalog_matches: data.medicines,
      price_data_status: { status: "blocked_unverified_classification", message: "No price offer was returned because prescription status/product identity is unverified." },
    }));
  }

  if (alternativeIntent) {
    const substitutes = curated.filter((candidate) => candidate.name !== detectedMed.name && identicalComposition(detectedMed, candidate));
    const summary = substitutes.length
      ? `Composition-equivalent candidates in the curated catalogue: ${substitutes.map((item) => item.name).join(", ")}. These are not a recommendation to switch; ask a doctor or pharmacist to confirm suitability.`
      : "No composition-equivalent alternative was found in the curated verified catalogue. Source-listed substitute names are not proof of equivalent ingredients.";
    return Response.json(emptyReply({
      answer: `${summary}\n\n${REQUIRED_DISCLAIMER}`,
      intent: "alternatives",
      detected_medication: detected(detectedMed),
      substitutes: substitutes.map((item) => ({ name: item.name, active_ingredients: item.activeIngredients, strength: item.strength, dosage_form: item.dosageForm, composition_verified: true as const })),
      sources: data.sources,
      catalog_matches: data.medicines,
    }));
  }

  if (priceIntent) {
    const result = detectedMed.schedule === "OTC"
      ? await lookupPartnerPrices({ medicineName: detectedMed.name, composition: detectedMed.composition || detectedMed.datasetComposition, strength: detectedMed.strength, dosageForm: detectedMed.dosageForm, packSize: detectedMed.packSize })
      : { status: "blocked_unverified_classification" as const, offers: [], message: "Prescription status is not verified; no live offers shown." };
    const offerText = result.offers.length
      ? result.offers.map((offer) => `${offer.pharmacy}: ₹${offer.price} / ${offer.pack_size} (${offer.in_stock ? "in stock" : "out of stock"}; quote updated ${offer.updated_at})`).join("\n")
      : result.message;
    return Response.json(emptyReply({
      answer: `Price information for ${detectedMed.name}:\n${offerText}\n\nThese are only the live offers returned by the configured partner feed. Check the product pack, delivery location, stock, and checkout total before deciding.\n\n${REQUIRED_DISCLAIMER}`,
      intent: "price_comparison",
      detected_medication: detected(detectedMed),
      partner_price_comparison: result.offers,
      price_data_status: { status: result.status, message: result.message },
      sources: data.sources,
      catalog_matches: data.medicines,
    }));
  }

  if (comparisonIntent) {
    return Response.json(emptyReply({
      answer: `I found ${detectedMed.name}, but a two-product comparison requires both exact medicine names to be identified independently. Please ask, for example, “Compare Crocin 650 and Dolo 650”.\n\n${REQUIRED_DISCLAIMER}`,
      intent: "medicine_comparison_needs_two_names",
      detected_medication: detected(detectedMed),
      sources: data.sources,
      catalog_matches: data.medicines,
    }));
  }

  const info: string[] = [
    `Medicine: ${detectedMed.name}`,
    `Composition: ${detectedMed.composition || detectedMed.datasetComposition || "Not verified in matched source records"}`,
    `Manufacturer: ${detectedMed.manufacturer || "Not listed"}`,
    `Product type: ${detectedMed.datasetType || detectedMed.category || "Not listed"}`,
    `Pack size: ${detectedMed.packSize || "Not listed"}`,
    `Reference price: ${detectedMed.datasetPrice != null ? `₹${detectedMed.datasetPrice} (dataset reference; not a live quote)` : detectedMed.mrp > 0 ? `₹${detectedMed.mrp} (curated catalogue value; not a live quote)` : "Not available"}`,
    `Prescription classification: ${detectedMed.schedule}${detectedMed.schedule === "Unverified" ? " — confirm with a qualified pharmacist; not assumed OTC" : " — verify the actual pack and local requirements"}`,
    detectedMed.datasetUses ? `Uses listed in the source dataset: ${detectedMed.datasetUses}` : "",
    detectedMed.datasetSideEffects ? `Side effects listed in the source dataset: ${detectedMed.datasetSideEffects}` : "",
    detectedMed.datasetSource ? `Source: ${detectedMed.datasetSource}` : "",
  ].filter(Boolean);
  return Response.json(emptyReply({
    answer: `${info.join("\n")}\n\nDataset fields can be incomplete or out of date and are not an assessment of whether this medicine is suitable for you.\n\n${REQUIRED_DISCLAIMER}`,
    intent: "medicine_information",
    detected_medication: detected(detectedMed),
    sources: data.sources,
    catalog_matches: data.medicines,
  }));
}
