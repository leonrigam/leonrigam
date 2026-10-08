import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { DatabaseSync } from 'node:sqlite';
import { createServer as createViteServer } from 'vite';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DB_PATH = path.resolve(__dirname, 'mama_rafiki.db');
const db = new DatabaseSync(DB_PATH);

// Initialize schema in mama_rafiki.db
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS mothers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    full_name TEXT NOT NULL,
    phone TEXT NOT NULL,
    village_clinic TEXT NOT NULL,
    pregnancy_stage TEXT NOT NULL,
    weeks_or_months INTEGER NOT NULL,
    baby_name TEXT,
    Visual_symbol TEXT NOT NULL DEFAULT 'sunflower',
    preferred_channel TEXT NOT NULL DEFAULT 'whatsapp',
    next_clinic_date TEXT NOT NULL,
    next_clinic_purpose_sw TEXT NOT NULL,
    next_clinic_purpose_en TEXT NOT NULL,
    notes_sw TEXT,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS clinic_visits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    mother_id INTEGER NOT NULL,
    visit_number INTEGER NOT NULL,
    title_sw TEXT NOT NULL,
    title_en TEXT NOT NULL,
    scheduled_date TEXT NOT NULL,
    status TEXT NOT NULL,
    services_json TEXT NOT NULL,
    audio_guide_sw TEXT NOT NULL,
    audio_guide_en TEXT NOT NULL,
    FOREIGN KEY (mother_id) REFERENCES mothers(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS vaccinations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    mother_id INTEGER NOT NULL,
    vaccine_code TEXT NOT NULL,
    vaccine_name_sw TEXT NOT NULL,
    vaccine_name_en TEXT NOT NULL,
    age_milestone_sw TEXT NOT NULL,
    age_milestone_en TEXT NOT NULL,
    age_weeks INTEGER NOT NULL,
    delivery_type TEXT NOT NULL,
    protects_against_sw TEXT NOT NULL,
    protects_against_en TEXT NOT NULL,
    due_date TEXT NOT NULL,
    status TEXT NOT NULL,
    administered_date TEXT,
    FOREIGN KEY (mother_id) REFERENCES mothers(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS reminders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    mother_id INTEGER NOT NULL,
    mother_name TEXT NOT NULL,
    phone TEXT NOT NULL,
    channel TEXT NOT NULL,
    reminder_type TEXT NOT NULL,
    message_sw TEXT NOT NULL,
    message_en TEXT NOT NULL,
    delivery_status TEXT NOT NULL,
    sent_at TEXT NOT NULL,
    FOREIGN KEY (mother_id) REFERENCES mothers(id) ON DELETE CASCADE
  );
`);

function addDaysISO(baseDateStr: string, offsetDays: number): string {
  const d = new Date(baseDateStr);
  d.setDate(d.getDate() + offsetDays);
  return d.toISOString().split('T')[0];
}

function buildDefaultScheduleForMother(
  motherId: number,
  motherName: string,
  stage: string,
  nextClinicDate: string
) {
  const insertVisit = db.prepare(`
    INSERT INTO clinic_visits (
      mother_id, visit_number, title_sw, title_en, scheduled_date, status, services_json, audio_guide_sw, audio_guide_en
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const visits = [
    {
      num: 1,
      title_sw: 'Kliniki ya Kwanza (ANC 1) — Uchunguzi wa Awali',
      title_en: 'First Antenatal Visit (ANC 1) — Baseline Checkup',
      date: addDaysISO(nextClinicDate, -60),
      status: 'completed',
      services: ['bp', 'blood_test', 'iron', 'net'],
      audio_sw: `Kliniki ya kwanza ya ${motherName} ilikamilika. Vipimo vya damu, shinikizo la damu, na chandarua cha mbu vilitolewa.`,
      audio_en: `First antenatal visit for ${motherName} completed. Blood pressure, baseline lab tests, iron supplements, and treated mosquito net provided.`
    },
    {
      num: 2,
      title_sw: 'Kliniki ya Pili (ANC 2) — Mapigo ya Moyo wa Mtoto',
      title_en: 'Second Antenatal Visit (ANC 2) — Fetal Heartbeat & Nutrition',
      date: addDaysISO(nextClinicDate, -30),
      status: 'completed',
      services: ['bp', 'heartbeat', 'iron', 'tetanus'],
      audio_sw: `Kliniki ya pili ilikamilika. Daktari alisikiliza mapigo ya moyo wa mtoto na kutoa chanjo ya pepopunda.`,
      audio_en: `Second visit completed. Nurse checked fetal heartbeat, maternal blood pressure, and administered tetanus toxoid protection.`
    },
    {
      num: 3,
      title_sw: 'Kliniki Ijayo (ANC 3) — Uchunguzi na Chanjo',
      title_en: 'Upcoming Clinic Visit (ANC 3) — Growth & Immunization Check',
      date: nextClinicDate,
      status: 'due_soon',
      services: ['bp', 'heartbeat', 'ultrasound', 'iron'],
      audio_sw: `Kliniki ijayo ya ${motherName} ni tarehe ${nextClinicDate}. Tafadhali fika kituoni asubuhi kwa kipimo cha ukuaji wa mtoto na vidonge vya kuongeza damu.`,
      audio_en: `Next clinic visit for ${motherName} is on ${nextClinicDate}. Please arrive in the morning for fetal growth check and iron folate refill.`
    },
    {
      num: 4,
      title_sw: 'Kliniki ya Nne (ANC 4) — Maandalizi ya Kujifungua',
      title_en: 'Fourth Antenatal Visit (ANC 4) — Safe Delivery Plan',
      date: addDaysISO(nextClinicDate, 28),
      status: 'upcoming',
      services: ['bp', 'heartbeat', 'birth_plan', 'danger_signs'],
      audio_sw: `Kliniki ya nne ni tarehe ${addDaysISO(nextClinicDate, 28)}. Tutapanga maandalizi salama ya kujifungua hospitalini.`,
      audio_en: `Fourth visit scheduled for ${addDaysISO(nextClinicDate, 28)} to review safe hospital delivery readiness and newborn care.`
    }
  ];

  for (const v of visits) {
    insertVisit.run(
      motherId,
      v.num,
      v.title_sw,
      v.title_en,
      v.date,
      v.status,
      JSON.stringify(v.services),
      v.audio_sw,
      v.audio_en
    );
  }

  const insertVaccine = db.prepare(`
    INSERT INTO vaccinations (
      mother_id, vaccine_code, vaccine_name_sw, vaccine_name_en,
      age_milestone_sw, age_milestone_en, age_weeks, delivery_type,
      protects_against_sw, protects_against_en, due_date, status, administered_date
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const isPostnatal = stage === 'postnatal';
  const baseDate = nextClinicDate;

  const vaccineTemplates = [
    {
      code: 'BCG',
      name_sw: 'Chanjo ya BCG (Kifua Kikuu)',
      name_en: 'BCG Vaccine (Tuberculosis)',
      milestone_sw: 'Wakati wa Kuzaliwa (Wiki 0)',
      milestone_en: 'At Birth (Week 0)',
      weeks: 0,
      delivery: 'injection',
      protects_sw: 'Inamlinda mtoto dhidi ya ugonjwa hatari wa Kifua Kikuu (TB). Sindano kwenye mkono wa kushoto.',
      protects_en: 'Protects newborn against severe Tuberculosis (TB). Single injection on the upper arm.',
      due: isPostnatal ? addDaysISO(baseDate, -42) : addDaysISO(baseDate, 30),
      status: isPostnatal ? 'completed' : 'upcoming',
      administered: isPostnatal ? addDaysISO(baseDate, -42) : null
    },
    {
      code: 'OPV-0',
      name_sw: 'Matone ya Polio ya Kwanza (OPV 0)',
      name_en: 'Oral Polio Vaccine Zero (OPV 0)',
      milestone_sw: 'Wakati wa Kuzaliwa (Wiki 0)',
      milestone_en: 'At Birth (Week 0)',
      weeks: 0,
      delivery: 'drops',
      protects_sw: 'Matone mawili mdomoni kumlinda mtoto dhidi ya kupooza (Polio). Hakuna maumivu ya sindano.',
      protects_en: 'Two oral drops in the mouth protecting against Polio paralysis. Painless oral dose.',
      due: isPostnatal ? addDaysISO(baseDate, -42) : addDaysISO(baseDate, 30),
      status: isPostnatal ? 'completed' : 'upcoming',
      administered: isPostnatal ? addDaysISO(baseDate, -42) : null
    },
    {
      code: 'PENTA-1',
      name_sw: 'Chanjo ya Pentavalent 1 (Magonjwa 5)',
      name_en: 'Pentavalent 1 (5-in-1 Protection)',
      milestone_sw: 'Wiki 6 Baada ya Kuzaliwa',
      milestone_en: '6 Weeks of Age',
      weeks: 6,
      delivery: 'injection',
      protects_sw: 'Inakinga magonjwa matano: Dondakoo, Kifaduro, Pepopunda, Homa ya Ini, na Homa ya Utando wa Ubongo.',
      protects_en: 'Protects against 5 diseases: Diphtheria, Pertussis, Tetanus, Hepatitis B, and Hib.',
      due: isPostnatal ? baseDate : addDaysISO(baseDate, 72),
      status: isPostnatal ? 'due_soon' : 'upcoming',
      administered: null
    },
    {
      code: 'PCV-1',
      name_sw: 'Chanjo ya Nimonia (PCV 1)',
      name_en: 'Pneumococcal Conjugate (PCV 1)',
      milestone_sw: 'Wiki 6 Baada ya Kuzaliwa',
      milestone_en: '6 Weeks of Age',
      weeks: 6,
      delivery: 'injection',
      protects_sw: 'Inamlinda mtoto dhidi ya Nimonia (Kichomi) na maambukizi ya masikio na damu.',
      protects_en: 'Protects baby against severe Pneumonia and pneumococcal infections.',
      due: isPostnatal ? baseDate : addDaysISO(baseDate, 72),
      status: isPostnatal ? 'due_soon' : 'upcoming',
      administered: null
    },
    {
      code: 'ROTA-1',
      name_sw: 'Matone ya Kuhara (Rotavirus 1)',
      name_en: 'Rotavirus Oral Drops 1',
      milestone_sw: 'Wiki 6 Baada ya Kuzaliwa',
      milestone_en: '6 Weeks of Age',
      weeks: 6,
      delivery: 'drops',
      protects_sw: 'Matone mdomoni yanayozuia kuhara kali kunakomaliza maji mwilini kwa watoto wachanga.',
      protects_en: 'Oral drops preventing severe dehydrating rotavirus diarrhea in infants.',
      due: isPostnatal ? baseDate : addDaysISO(baseDate, 72),
      status: isPostnatal ? 'due_soon' : 'upcoming',
      administered: null
    },
    {
      code: 'PENTA-2',
      name_sw: 'Chanjo ya Pentavalent 2 & Polio 2',
      name_en: 'Pentavalent 2 & OPV 2 Booster',
      milestone_sw: 'Wiki 10 Baada ya Kuzaliwa',
      milestone_en: '10 Weeks of Age',
      weeks: 10,
      delivery: 'injection',
      protects_sw: 'Dozi ya pili ya kuimarisha kinga dhidi ya magonjwa matano na kupooza.',
      protects_en: 'Second booster dose strengthening immunity against the 5 core childhood illnesses.',
      due: isPostnatal ? addDaysISO(baseDate, 28) : addDaysISO(baseDate, 100),
      status: 'upcoming',
      administered: null
    },
    {
      code: 'PENTA-3',
      name_sw: 'Chanjo ya Pentavalent 3 & IPV',
      name_en: 'Pentavalent 3 & Inactivated Polio (IPV)',
      milestone_sw: 'Wiki 14 Baada ya Kuzaliwa',
      milestone_en: '14 Weeks of Age',
      weeks: 14,
      delivery: 'injection',
      protects_sw: 'Dozi ya tatu kamili ya kinga ya utotoni pamoja na sindano ya Polio.',
      protects_en: 'Third primary series dose plus injectable Polio protection.',
      due: isPostnatal ? addDaysISO(baseDate, 56) : addDaysISO(baseDate, 128),
      status: 'upcoming',
      administered: null
    },
    {
      code: 'MR-1',
      name_sw: 'Chanjo ya Surua na Rubella (MR 1)',
      name_en: 'Measles-Rubella 1 & Vitamin A',
      milestone_sw: 'Miezi 9 (Wiki 36)',
      milestone_en: '9 Months of Age',
      weeks: 36,
      delivery: 'injection',
      protects_sw: 'Inamlinda mtoto dhidi ya Surua, Rubella, na upofu kwa matone ya Vitamini A.',
      protects_en: 'Protects child against Measles, Rubella, and blindness with Vitamin A supplementation.',
      due: isPostnatal ? addDaysISO(baseDate, 180) : addDaysISO(baseDate, 270),
      status: 'upcoming',
      administered: null
    }
  ];

  for (const vt of vaccineTemplates) {
    insertVaccine.run(
      motherId,
      vt.code,
      vt.name_sw,
      vt.name_en,
      vt.milestone_sw,
      vt.milestone_en,
      vt.weeks,
      vt.delivery,
      vt.protects_sw,
      vt.protects_en,
      vt.due,
      vt.status,
      vt.administered
    );
  }
}

function seedDatabaseIfNeeded() {
  const countRow = db.prepare('SELECT COUNT(*) as count FROM mothers').get() as { count: number };
  if (countRow && Number(countRow.count) > 0) {
    return;
  }

  const today = new Date().toISOString().split('T')[0];

  const insertMother = db.prepare(`
    INSERT INTO mothers (
      full_name, phone, village_clinic, pregnancy_stage, weeks_or_months,
      baby_name, Visual_symbol, preferred_channel, next_clinic_date,
      next_clinic_purpose_sw, next_clinic_purpose_en, notes_sw, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const initialMothers = [
    {
      full_name: 'Amina Juma Bakari',
      phone: '+254 712 345 678',
      village_clinic: 'Kituo cha Afya cha Kilifi (Kilifi Health Center)',
      pregnancy_stage: 'trimester_3',
      weeks_or_months: 32,
      baby_name: null,
      symbol: 'sunflower',
      channel: 'whatsapp',
      next_clinic: addDaysISO(today, 3),
      purpose_sw: 'Kliniki ya 3 (Wiki 32): Kipimo cha mapigo ya mtoto, shinikizo la damu, na vidonge vya kuongeza damu.',
      purpose_en: 'ANC Visit 3 (Week 32): Fetal heartbeat check, blood pressure screening, and iron/folate refill.',
      notes_sw: 'Mama anaendelea vizuri. Kumbuka kubeba kitabu cha kliniki cha rangi ya waridi.'
    },
    {
      full_name: 'Neema Wanjiku Mwangi',
      phone: '+254 723 890 112',
      village_clinic: 'Zahanati ya Kisumu Vijijini (Kisumu Rural Dispensary)',
      pregnancy_stage: 'postnatal',
      weeks_or_months: 6,
      baby_name: 'Mtoto Baraka',
      symbol: 'baobab',
      channel: 'whatsapp',
      next_clinic: addDaysISO(today, 2),
      purpose_sw: 'Chanjo za Wiki 6 kwa Mtoto Baraka: Pentavalent 1, Nimonia (PCV 1), na Matone ya Rotavirus.',
      purpose_en: '6-Week Immunization for Baby Baraka: Pentavalent 1, PCV 1, and Rotavirus oral drops.',
      notes_sw: 'Mtoto Baraka ananyonya vizuri. Chanjo ya BCG na Polio 0 zilitolewa wakati wa kuzaliwa.'
    },
    {
      full_name: 'Halima Hassan Omar',
      phone: '+255 754 210 987',
      village_clinic: 'Hospitali ya Mama na Mtoto Mombasa (Coast Maternal Clinic)',
      pregnancy_stage: 'trimester_2',
      weeks_or_months: 20,
      baby_name: null,
      symbol: 'star',
      channel: 'sms',
      next_clinic: addDaysISO(today, 6),
      purpose_sw: 'Kliniki ya Mwezi wa 5 (Wiki 20): Kipimo cha Ultrasound, chanjo ya Pepopunda, na kinga ya Malaria.',
      purpose_en: 'Month 5 ANC Checkup (Week 20): Fetal ultrasound scan, Tetanus Toxoid dose, and Malaria IPTp.',
      notes_sw: 'Mpe mama dawa ya kuzuia malaria (SP) na chandarua chenye dawa.'
    },
    {
      full_name: 'Zawadi Muthoni Kilonzo',
      phone: '+254 733 441 559',
      village_clinic: 'Kituo cha Afya Machakos (Machakos Community Clinic)',
      pregnancy_stage: 'trimester_1',
      weeks_or_months: 12,
      baby_name: null,
      symbol: 'sunrise',
      channel: 'whatsapp',
      next_clinic: addDaysISO(today, 5),
      purpose_sw: 'Kliniki ya Kwanza ya Ujauzito (Wiki 12): Vipimo vya awali vya damu na ushauri wa lishe bora.',
      purpose_en: 'First Trimester Booking (Week 12): Baseline blood profile, Folic acid, and maternal nutrition guide.',
      notes_sw: 'Ujauzito wa miezi mitatu ya kwanza. Ushauri wa vyakula vya mboga za majani na matunda.'
    }
  ];

  const insertReminder = db.prepare(`
    INSERT INTO reminders (
      mother_id, mother_name, phone, channel, reminder_type,
      message_sw, message_en, delivery_status, sent_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  for (const m of initialMothers) {
    const res = insertMother.run(
      m.full_name,
      m.phone,
      m.village_clinic,
      m.pregnancy_stage,
      m.weeks_or_months,
      m.baby_name,
      m.symbol,
      m.channel,
      m.next_clinic,
      m.purpose_sw,
      m.purpose_en,
      m.notes_sw,
      new Date().toISOString()
    );
    const motherId = Number(res.lastInsertRowid);
    buildDefaultScheduleForMother(motherId, m.full_name, m.pregnancy_stage, m.next_clinic);

    insertReminder.run(
      motherId,
      m.full_name,
      m.phone,
      m.channel,
      m.pregnancy_stage === 'postnatal' ? 'vaccine' : 'clinic',
      `Habari Mama ${m.full_name}! Huu ni ukumbusho wa sauti kutoka Mama-Rafiki. Tarehe yako ya kliniki katika ${m.village_clinic} ni ${m.next_clinic}. ${m.purpose_sw}`,
      `Hello Mama ${m.full_name}! Audio reminder from Mama-Rafiki: Your next visit at ${m.village_clinic} is on ${m.next_clinic}. ${m.purpose_en}`,
      'delivered',
      new Date(Date.now() - 3600 * 1000 * 5).toISOString()
    );
  }
}

seedDatabaseIfNeeded();

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json());

  app.get('/api/health', (_req, res) => {
    const mothersCount = (db.prepare('SELECT COUNT(*) as c FROM mothers').get() as { c: number }).c;
    const visitsCount = (db.prepare('SELECT COUNT(*) as c FROM clinic_visits').get() as { c: number }).c;
    const vaccinesCount = (db.prepare('SELECT COUNT(*) as c FROM vaccinations').get() as { c: number }).c;
    const completedVaccines = (
      db.prepare("SELECT COUNT(*) as c FROM vaccinations WHERE status = 'completed'").get() as { c: number }
    ).c;
    const remindersCount = (db.prepare('SELECT COUNT(*) as c FROM reminders').get() as { c: number }).c;

    res.json({
      status: 'connected',
      databaseFile: 'mama_rafiki.db',
      engine: 'SQLite3 (node:sqlite WAL)',
      runtime: 'Node.js + Express REST API',
      counts: {
        mothers: Number(mothersCount),
        clinicVisits: Number(visitsCount),
        vaccinations: Number(vaccinesCount),
        completedVaccinations: Number(completedVaccines),
        remindersSent: Number(remindersCount)
      },
      timestamp: new Date().toISOString()
    });
  });

  app.get('/api/mothers', (_req, res) => {
    const mothers = db
      .prepare('SELECT * FROM mothers ORDER BY next_clinic_date ASC, id DESC')
      .all() as Record<string, unknown>[];

    const enriched = mothers.map((m) => {
      const id = Number(m.id);
      const visits = db
        .prepare('SELECT * FROM clinic_visits WHERE mother_id = ? ORDER BY visit_number ASC')
        .all(id) as Record<string, unknown>[];
      const vaccines = db
        .prepare('SELECT * FROM vaccinations WHERE mother_id = ? ORDER BY age_weeks ASC, id ASC')
        .all(id) as Record<string, unknown>[];

      const parsedVisits = visits.map((v) => ({
        ...v,
        services: JSON.parse(String(v.services_json || '[]'))
      }));

      return {
        ...m,
        visual_symbol: m.Visual_symbol || m.visual_symbol || 'sunflower',
        clinic_visits: parsedVisits,
        vaccinations: vaccines
      };
    });

    res.json(enriched);
  });

  app.post('/api/mothers', (req, res) => {
    const {
      full_name,
      phone,
      village_clinic,
      pregnancy_stage = 'trimester_2',
      weeks_or_months = 20,
      baby_name = null,
      visual_symbol = 'sunflower',
      preferred_channel = 'whatsapp',
      next_clinic_date
    } = req.body || {};

    if (!full_name || !phone || !village_clinic) {
      res.status(400).json({ error: 'Jina la mama, namba ya simu, na kituo cha afya vinahitajika.' });
      return;
    }

    const today = new Date().toISOString().split('T')[0];
    const scheduledDate = next_clinic_date || addDaysISO(today, 7);

    const stageDescriptions: Record<string, { sw: string; en: string }> = {
      trimester_1: {
        sw: `Kliniki ya Miezi 3 ya Kwanza (Wiki ${weeks_or_months}): Vipimo vya damu, Folic Acid, na chandarua.`,
        en: `First Trimester Checkup (Week ${weeks_or_months}): Baseline blood tests, Folic Acid, and mosquito net.`
      },
      trimester_2: {
        sw: `Kliniki ya Miezi ya Kati (Wiki ${weeks_or_months}): Kusikiliza mapigo ya mtoto na chanjo ya Pepopunda.`,
        en: `Second Trimester Checkup (Week ${weeks_or_months}): Fetal heartbeat check and Tetanus protection.`
      },
      trimester_3: {
        sw: `Kliniki ya Miezi ya Mwisho (Wiki ${weeks_or_months}): Maandalizi ya kujifungua salama na shinikizo la damu.`,
        en: `Third Trimester Checkup (Week ${weeks_or_months}): Safe delivery plan and blood pressure monitoring.`
      },
      postnatal: {
        sw: `Kliniki ya Mama na Mtoto (${baby_name || 'Mtoto'}): Kupima uzito wa mtoto na chanjo za awali.`,
        en: `Postnatal & Well-Baby Clinic (${baby_name || 'Newborn'}): Infant weight check and routine immunizations.`
      }
    };

    const desc = stageDescriptions[pregnancy_stage] || stageDescriptions.trimester_2;

    const insertMother = db.prepare(`
      INSERT INTO mothers (
        full_name, phone, village_clinic, pregnancy_stage, weeks_or_months,
        baby_name, Visual_symbol, preferred_channel, next_clinic_date,
        next_clinic_purpose_sw, next_clinic_purpose_en, notes_sw, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const result = insertMother.run(
      String(full_name).trim(),
      String(phone).trim(),
      String(village_clinic).trim(),
      String(pregnancy_stage),
      Number(weeks_or_months) || 20,
      baby_name ? String(baby_name).trim() : null,
      String(visual_symbol),
      String(preferred_channel),
      scheduledDate,
      desc.sw,
      desc.en,
      'Amesajiliwa kupitia mfumo wa sauti wa Mama-Rafiki.',
      new Date().toISOString()
    );

    const motherId = Number(result.lastInsertRowid);
    buildDefaultScheduleForMother(motherId, String(full_name).trim(), String(pregnancy_stage), scheduledDate);

    db.prepare(`
      INSERT INTO reminders (
        mother_id, mother_name, phone, channel, reminder_type,
        message_sw, message_en, delivery_status, sent_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      motherId,
      String(full_name).trim(),
      String(phone).trim(),
      String(preferred_channel),
      'clinic',
      `Karibu Mama ${String(full_name).trim()} kwenye Mama-Rafiki! Kliniki yako ijayo katika ${String(village_clinic).trim()} imepangwa tarehe ${scheduledDate}.`,
      `Welcome Mama ${String(full_name).trim()} to Mama-Rafiki! Your next clinic visit at ${String(village_clinic).trim()} is scheduled for ${scheduledDate}.`,
      'delivered',
      new Date().toISOString()
    );

    const newMother = db.prepare('SELECT * FROM mothers WHERE id = ?').get(motherId) as Record<string, unknown>;
    const visits = db
      .prepare('SELECT * FROM clinic_visits WHERE mother_id = ? ORDER BY visit_number ASC')
      .all(motherId) as Record<string, unknown>[];
    const vaccines = db
      .prepare('SELECT * FROM vaccinations WHERE mother_id = ? ORDER BY age_weeks ASC, id ASC')
      .all(motherId) as Record<string, unknown>[];

    res.status(201).json({
      ...newMother,
      visual_symbol: newMother.Visual_symbol || visual_symbol,
      clinic_visits: visits.map((v) => ({ ...v, services: JSON.parse(String(v.services_json || '[]')) })),
      vaccinations: vaccines
    });
  });

  // Delete a mother and all related clinic visits, vaccinations, and reminders
  app.delete('/api/mothers/:id', (req, res) => {
    const motherId = Number(req.params.id);
    const existing = db.prepare('SELECT * FROM mothers WHERE id = ?').get(motherId) as Record<string, unknown> | undefined;
    if (!existing) {
      res.status(404).json({ error: 'Mama hakupatikana kwenye hifadhidata.' });
      return;
    }

    db.prepare('DELETE FROM clinic_visits WHERE mother_id = ?').run(motherId);
    db.prepare('DELETE FROM vaccinations WHERE mother_id = ?').run(motherId);
    db.prepare('DELETE FROM reminders WHERE mother_id = ?').run(motherId);
    db.prepare('DELETE FROM mothers WHERE id = ?').run(motherId);

    res.json({
      success: true,
      deletedId: motherId,
      deletedName: existing.full_name
    });
  });

  app.patch('/api/clinic-visits/:id', (req, res) => {
    const visitId = Number(req.params.id);
    const { status, scheduled_date } = req.body || {};

    const existing = db.prepare('SELECT * FROM clinic_visits WHERE id = ?').get(visitId) as Record<string, unknown> | undefined;
    if (!existing) {
      res.status(404).json({ error: 'Clinic visit not found' });
      return;
    }

    const updatedStatus = status || existing.status;
    const updatedDate = scheduled_date || existing.scheduled_date;

    db.prepare('UPDATE clinic_visits SET status = ?, scheduled_date = ? WHERE id = ?').run(
      String(updatedStatus),
      String(updatedDate),
      visitId
    );

    const motherId = Number(existing.mother_id);
    const nextPending = db
      .prepare(
        "SELECT * FROM clinic_visits WHERE mother_id = ? AND status != 'completed' ORDER BY scheduled_date ASC LIMIT 1"
      )
      .get(motherId) as Record<string, unknown> | undefined;

    if (nextPending) {
      db.prepare(
        'UPDATE mothers SET next_clinic_date = ?, next_clinic_purpose_sw = ?, next_clinic_purpose_en = ? WHERE id = ?'
      ).run(
        String(nextPending.scheduled_date),
        String(nextPending.title_sw),
        String(nextPending.title_en),
        motherId
      );
    }

    const updated = db.prepare('SELECT * FROM clinic_visits WHERE id = ?').get(visitId) as Record<string, unknown>;
    res.json({
      ...updated,
      services: JSON.parse(String(updated.services_json || '[]'))
    });
  });

  app.patch('/api/vaccinations/:id', (req, res) => {
    const vaccineId = Number(req.params.id);
    const { status } = req.body || {};

    const existing = db.prepare('SELECT * FROM vaccinations WHERE id = ?').get(vaccineId) as Record<string, unknown> | undefined;
    if (!existing) {
      res.status(404).json({ error: 'Vaccination record not found' });
      return;
    }

    const nextStatus =
      status || (existing.status === 'completed' ? 'due_soon' : 'completed');
    const administeredDate =
      nextStatus === 'completed' ? new Date().toISOString().split('T')[0] : null;

    db.prepare(
      'UPDATE vaccinations SET status = ?, administered_date = ? WHERE id = ?'
    ).run(String(nextStatus), administeredDate, vaccineId);

    const updated = db.prepare('SELECT * FROM vaccinations WHERE id = ?').get(vaccineId);
    res.json(updated);
  });

  app.get('/api/reminders', (_req, res) => {
    const rows = db
      .prepare('SELECT * FROM reminders ORDER BY id DESC LIMIT 30')
      .all();
    res.json(rows);
  });

  app.post('/api/reminders/send', (req, res) => {
    const {
      mother_id,
      channel = 'whatsapp',
      reminder_type = 'clinic',
      custom_message_sw
    } = req.body || {};

    const mother = mother_id
      ? (db.prepare('SELECT * FROM mothers WHERE id = ?').get(Number(mother_id)) as Record<string, unknown> | undefined)
      : (db.prepare('SELECT * FROM mothers ORDER BY next_clinic_date ASC LIMIT 1').get() as Record<string, unknown> | undefined);

    if (!mother) {
      res.status(404).json({ error: 'Hakuna mama aliyepatikana.' });
      return;
    }

    const mName = String(mother.full_name);
    const mPhone = String(mother.phone);
    const mClinic = String(mother.village_clinic);
    const mDate = String(mother.next_clinic_date);

    let messageSw = '';
    let messageEn = '';

    if (custom_message_sw && String(custom_message_sw).trim()) {
      messageSw = String(custom_message_sw).trim();
      messageEn = `Custom Voice/Text Reminder for ${mName} (${mClinic}) on ${mDate}.`;
    } else if (reminder_type === 'vaccine') {
      const nextVac = db
        .prepare("SELECT * FROM vaccinations WHERE mother_id = ? AND status != 'completed' ORDER BY age_weeks ASC LIMIT 1")
        .get(Number(mother.id)) as Record<string, unknown> | undefined;
      const vacName = nextVac ? String(nextVac.vaccine_name_sw) : 'Chanjo ya Mtoto';
      const vacNameEn = nextVac ? String(nextVac.vaccine_name_en) : 'Child Immunization';
      messageSw = `Habari Mama ${mName}! Huu ni ukumbusho kutoka Mama-Rafiki. Tafadhali mlete mtoto katika ${mClinic} tarehe ${mDate} kwa ajili ya ${vacName}. Kinga ni uhai wa mtoto wako!`;
      messageEn = `Hello Mama ${mName}! Reminder from Mama-Rafiki: Please bring your baby to ${mClinic} on ${mDate} for ${vacNameEn}. Immunization protects your child's life!`;
    } else if (reminder_type === 'nutrition') {
      messageSw = `Habari Mama ${mName}! Ushauri wa afya kutoka Mama-Rafiki: Kumbuka kunywa vidonge vya kuongeza damu kila siku, kula mboga za majani na maharagwe, na kulala ndani ya chandarua. Ukiona dalili ya hatari fika ${mClinic} mara moja.`;
      messageEn = `Hello Mama ${mName}! Health tip from Mama-Rafiki: Remember to take your daily iron & folate tablet, eat leafy greens and beans, and sleep under a treated net. Visit ${mClinic} immediately if you notice any warning signs.`;
    } else {
      messageSw = `Habari Mama ${mName}! Huu ni ukumbusho wa sauti kutoka Mama-Rafiki. Tarehe yako ya kliniki ijayo katika ${mClinic} ni ${mDate}. Tafadhali beba kitabu chako cha kliniki asubuhi.`;
      messageEn = `Hello Mama ${mName}! Voice reminder from Mama-Rafiki: Your next antenatal clinic visit at ${mClinic} is on ${mDate}. Please bring your maternal clinic booklet in the morning.`;
    }

    const result = db.prepare(`
      INSERT INTO reminders (
        mother_id, mother_name, phone, channel, reminder_type,
        message_sw, message_en, delivery_status, sent_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      Number(mother.id),
      mName,
      mPhone,
      String(channel),
      String(reminder_type),
      messageSw,
      messageEn,
      'delivered',
      new Date().toISOString()
    );

    const created = db.prepare('SELECT * FROM reminders WHERE id = ?').get(Number(result.lastInsertRowid));
    res.status(201).json(created);
  });

  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa'
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Mama-Rafiki Server & SQLite (mama_rafiki.db) running on http://0.0.0.0:${PORT}`);
  });
}

startServer();
