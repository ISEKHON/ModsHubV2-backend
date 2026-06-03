// =============================================================================
// ModsHubV2 — Database Seed Script
// Run: npx prisma db seed   (or: npx tsx prisma/seed.ts)
// =============================================================================

import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcrypt";

const prisma = new PrismaClient();

// ---------------------------------------------------------------------------
// Helper: picsum image URL (mirrors frontend mock-data.ts)
// ---------------------------------------------------------------------------
const IMG = (id: number) => `https://picsum.photos/seed/fsmod${id}/800/500`;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const BCRYPT_ROUNDS = 12;

async function main() {
  // -------------------------------------------------------------------------
  // Idempotency check — skip if users already exist
  // -------------------------------------------------------------------------
  const existingUsers = await prisma.user.count();
  if (existingUsers > 0) {
    console.log(
      `⏭  Database already seeded (${existingUsers} users found). Skipping.`
    );
    return;
  }

  console.log("🌱 Seeding ModsHubV2 database...\n");

  // -------------------------------------------------------------------------
  // Hash passwords up-front (most expensive operation)
  // -------------------------------------------------------------------------
  const [ownerHash, adminHash, modderHash, memberHash, bannedHash] =
    await Promise.all([
      bcrypt.hash("admin123", BCRYPT_ROUNDS),
      bcrypt.hash("admin123", BCRYPT_ROUNDS),
      bcrypt.hash("modder123", BCRYPT_ROUNDS),
      bcrypt.hash("member123", BCRYPT_ROUNDS),
      bcrypt.hash("banned123", BCRYPT_ROUNDS),
    ]);

  // -------------------------------------------------------------------------
  // Run all inserts inside a single transaction for atomicity
  // -------------------------------------------------------------------------
  await prisma.$transaction(
    async (tx) => {
    // -----------------------------------------------------------------------
    // 1. Owner account
    // -----------------------------------------------------------------------
    const owner = await tx.user.create({
      data: {
        username: "sekhon",
        email: "owner@fsmodshub.com",
        passwordHash: ownerHash,
        displayName: "SEKHON",
        bio: "Developer & Modder | Creator of FS Mods Hub",
        role: "owner",
        status: "active",
        isVerified: true,
        verifiedAt: new Date(),
        createdAt: new Date("2025-01-01T00:00:00Z"),
      },
    });
    console.log("  ✅ Owner account created: SEKHON");

    // -----------------------------------------------------------------------
    // 2. Admin account
    // -----------------------------------------------------------------------
    const admin = await tx.user.create({
      data: {
        username: "admin",
        email: "admin@fsmodshub.com",
        passwordHash: adminHash,
        displayName: "Admin",
        bio: "Platform administrator",
        role: "admin",
        status: "active",
        isVerified: true,
        verifiedAt: new Date(),
        verifiedById: owner.id, // verified by owner
        createdAt: new Date("2025-01-01T00:00:00Z"),
      },
    });
    console.log("  ✅ Admin account created: Admin");

    // -----------------------------------------------------------------------
    // 3. Modder accounts (11 modders — 5 named + 6 additional from mock mods)
    // -----------------------------------------------------------------------
    const modderData = [
      {
        username: "agrimodding",
        email: "contact@agrimodding.com",
        displayName: "AgriModding",
        bio: "Premium agricultural vehicle mods",
        createdAt: new Date("2025-07-10T11:30:00Z"),
      },
      {
        username: "mapmaster_us",
        email: "maps@mapmaster.us",
        displayName: "MapMaster_US",
        bio: "American-style map creator",
        createdAt: new Date("2025-05-28T16:00:00Z"),
      },
      {
        username: "harvestking",
        email: "king@harvestmods.com",
        displayName: "HarvestKing",
        bio: "Combine and harvester specialist",
        createdAt: new Date("2025-02-14T10:00:00Z"),
      },
      {
        username: "germanmods",
        email: "info@germanmods.de",
        displayName: "GermanMods",
        bio: "German engineering, FS modding",
        createdAt: new Date("2025-04-20T15:30:00Z"),
      },
      {
        username: "farmtech_pro",
        email: "pro@farmtech.io",
        displayName: "FarmTech_Pro",
        bio: "Precision farming implement mods",
        createdAt: new Date("2025-08-15T09:00:00Z"),
      },
      // Additional modders to cover all 12 mods from mock data
      {
        username: "alpenmodder",
        email: "alpen@modding.at",
        displayName: "AlpenModder",
        bio: "Alpine & European map specialist",
        createdAt: new Date("2025-03-01T10:00:00Z"),
      },
      {
        username: "livestocklabs",
        email: "labs@livestock.io",
        displayName: "LivestockLabs",
        bio: "Animal management mod experts",
        createdAt: new Date("2025-09-05T08:00:00Z"),
      },
      {
        username: "builderbob_fs",
        email: "bob@builders.fs",
        displayName: "BuilderBob_FS",
        bio: "Placeable buildings and structures",
        createdAt: new Date("2025-06-01T12:00:00Z"),
      },
      {
        username: "realfarm_team",
        email: "team@realfarm.gg",
        displayName: "RealFarm_Team",
        bio: "Realism gameplay overhaul team",
        createdAt: new Date("2025-04-10T07:00:00Z"),
      },
      {
        username: "autofarm_ai",
        email: "ai@autofarm.dev",
        displayName: "AutoFarm_AI",
        bio: "AI-powered farming automation",
        createdAt: new Date("2025-05-01T10:00:00Z"),
      },
      {
        username: "blueforce_fs",
        email: "blue@forcemods.nl",
        displayName: "BlueForce_FS",
        bio: "New Holland & CNH brand specialist",
        createdAt: new Date("2025-11-01T14:00:00Z"),
      },
    ];

    const modders: Record<string, { id: string }> = {};
    for (const m of modderData) {
      const user = await tx.user.create({
        data: {
          ...m,
          passwordHash: modderHash,
          role: "modder",
          status: "active",
        },
      });
      modders[m.displayName] = user;
    }
    console.log(`  ✅ ${modderData.length} modder accounts created`);

    // -----------------------------------------------------------------------
    // 4. Member accounts (5)
    // -----------------------------------------------------------------------
    const memberData = [
      {
        username: "johnfarmer",
        email: "john@example.com",
        displayName: "John Farmer",
        bio: "Weekend farmer, full-time gamer",
        createdAt: new Date("2025-03-15T10:00:00Z"),
      },
      {
        username: "sarahfields",
        email: "sarah.fields@gmail.com",
        displayName: "Sarah Fields",
        bio: "Love all things farming sim",
        createdAt: new Date("2025-04-02T14:20:00Z"),
      },
      {
        username: "mikeharvest",
        email: "mike.h@outlook.com",
        displayName: "Mike Harvest",
        bio: "Casual player, mod enthusiast",
        createdAt: new Date("2025-06-18T09:00:00Z"),
      },
      {
        username: "tractorfan2000",
        email: "tractorfan@mail.de",
        displayName: "TractorFan2000",
        bio: "Tractors are life 🚜",
        createdAt: new Date("2025-08-04T07:45:00Z"),
      },
      {
        username: "elenacrops",
        email: "elena.c@farmnet.eu",
        displayName: "Elena Crops",
        bio: "Farming sim veteran since FS13",
        createdAt: new Date("2025-10-19T13:00:00Z"),
      },
    ];

    const members: Record<string, { id: string }> = {};
    for (const m of memberData) {
      const user = await tx.user.create({
        data: {
          ...m,
          passwordHash: memberHash,
          role: "member",
          status: "active",
        },
      });
      members[m.displayName] = user;
    }
    console.log(`  ✅ ${memberData.length} member accounts created`);

    // -----------------------------------------------------------------------
    // 5. Banned users (2)
    // -----------------------------------------------------------------------
    const bannedData = [
      {
        username: "spambot_99",
        email: "spammer@fakeemail.net",
        displayName: "SpamBot_99",
        banReason: "TOS violation — automated spam activity",
        createdAt: new Date("2025-09-22T03:14:00Z"),
      },
      {
        username: "xxmodhackerxx",
        email: "hacker@tempmail.org",
        displayName: "xXModHackerXx",
        banReason: "TOS violation — distributing stolen mods",
        createdAt: new Date("2025-11-11T22:10:00Z"),
      },
    ];

    for (const b of bannedData) {
      await tx.user.create({
        data: {
          ...b,
          passwordHash: bannedHash,
          role: "member",
          status: "banned",
        },
      });
    }
    console.log("  ✅ 2 banned user accounts created");

    // -----------------------------------------------------------------------
    // 6. Mods (all 12 from frontend mock data)
    //
    // Access type logic:
    //   - is_paid + unlock_code  → "unlock_code"
    //   - is_paid + !unlock_code → "paid"  (used for JD 8R & Seasons Reloaded to demo chat)
    //   - !is_paid               → "free"
    //
    // Per the spec: John Deere 8R (mod 1) and Seasons Reloaded (mod 9)
    // should be accessType=paid to demo the chat/payment feature.
    // The others with is_paid=true keep unlock_code access type.
    // -----------------------------------------------------------------------

    // Map author display name → modder user ID
    const authorMap: Record<string, string> = {};
    for (const [name, user] of Object.entries(modders)) {
      authorMap[name] = user.id;
    }

    interface ModSeedData {
      title: string;
      description: string;
      shortDescription: string;
      game: string;
      version: string;
      authorName: string;
      tags: string[];
      iconUrl: string;
      gallery: string[];
      accessType: "free" | "paid" | "unlock_code";
      price: number;
      unlockCode: string | null;
      category: string;
      fileSizeMb: number;
      downloads: number;
      views: number;
      shares: number;
      featured: boolean;
      createdAt: string;
      updatedAt: string;
    }

    const modsData: ModSeedData[] = [
      {
        title: "John Deere 8R Series Tractor Pack",
        description:
          "The ultimate John Deere 8R series pack for Farming Simulator. Includes the 8R 230, 8R 310, and 8R 410 with fully customizable options including wheel configurations, engine tuning, GPS systems, and front loader attachments. Each model features realistic engine sounds recorded from actual JD 8R tractors, detailed interior with working gauges, and accurate PTO animations. Compatible with all standard implements and trailers.\n\nFeatures:\n- 3 tractor models (8R 230, 8R 310, 8R 410)\n- 12 wheel configurations\n- Realistic engine sounds\n- Working GPS guidance system\n- Front loader ready\n- Full color customization",
        shortDescription:
          "Premium John Deere 8R pack with 3 models and full customization",
        game: "fs25",
        version: "2.1.0",
        authorName: "AgriModding",
        tags: ["tractor", "john-deere", "premium"],
        iconUrl: IMG(1),
        gallery: [IMG(11), IMG(12), IMG(13), IMG(14)],
        accessType: "paid", // changed from unlock_code to paid for chat demo
        price: 425, // ₹425 (approx $4.99)
        unlockCode: null,
        category: "vehicles",
        fileSizeMb: 156.2,
        downloads: 28450,
        views: 89200,
        shares: 3420,
        featured: true,
        createdAt: "2025-11-15T10:00:00Z",
        updatedAt: "2026-03-20T14:30:00Z",
      },
      {
        title: "Midwest Harvest Map",
        description:
          "A massive 4x map inspired by the heartland of America. Features 120 fields ranging from small family plots to massive commercial operations, 3 towns with sell points, grain elevators, and livestock markets. Includes custom terrain textures, seasonal foliage changes, and dynamic weather patterns.\n\nMap Highlights:\n- 120 farmable fields\n- 3 towns with full infrastructure\n- Rail network with functioning trains\n- Custom terrain and foliage\n- Optimized for multiplayer",
        shortDescription:
          "Massive 4x American heartland map with 120 fields",
        game: "fs25",
        version: "1.3.0",
        authorName: "MapMaster_US",
        tags: ["map", "american", "4x"],
        iconUrl: IMG(2),
        gallery: [IMG(21), IMG(22), IMG(23)],
        accessType: "free",
        price: 0,
        unlockCode: null,
        category: "maps",
        fileSizeMb: 892.5,
        downloads: 67800,
        views: 156300,
        shares: 8900,
        featured: true,
        createdAt: "2025-09-01T08:00:00Z",
        updatedAt: "2026-04-10T16:00:00Z",
      },
      {
        title: "Case IH Axial-Flow 9250 Harvester",
        description:
          "High-detail Case IH Axial-Flow 9250 combine harvester with working header animations, realistic threshing sounds, and grain tank fill visualization. Features multiple header options and a detailed cabin interior.",
        shortDescription:
          "Detailed Case IH 9250 combine with realistic animations",
        game: "fs22",
        version: "1.5.2",
        authorName: "HarvestKing",
        tags: ["harvester", "case-ih", "combine"],
        iconUrl: IMG(3),
        gallery: [IMG(31), IMG(32)],
        accessType: "free",
        price: 0,
        unlockCode: null,
        category: "harvesters",
        fileSizeMb: 234.8,
        downloads: 45200,
        views: 112000,
        shares: 5600,
        featured: true,
        createdAt: "2025-06-20T12:00:00Z",
        updatedAt: "2026-01-15T09:00:00Z",
      },
      {
        title: "Precision Seeder Pack",
        description:
          "Collection of 6 precision seeders from top manufacturers. Each seeder features accurate seed placement mechanics, variable rate seeding, and GPS section control. Perfect for realistic farming operations.",
        shortDescription: "6 precision seeders with GPS section control",
        game: "fs25",
        version: "1.0.0",
        authorName: "FarmTech_Pro",
        tags: ["seeder", "implements", "precision"],
        iconUrl: IMG(4),
        gallery: [IMG(41), IMG(42)],
        accessType: "unlock_code",
        price: 250, // ₹250 (approx $2.99)
        unlockCode: "SEED-PACK-7X",
        category: "implements",
        fileSizeMb: 89.3,
        downloads: 12300,
        views: 34500,
        shares: 1200,
        featured: false,
        createdAt: "2026-01-10T14:00:00Z",
        updatedAt: "2026-04-05T11:00:00Z",
      },
      {
        title: "Bavarian Alps Map",
        description:
          "Experience farming in the stunning Bavarian Alps. This medium-sized map features steep hillside fields, traditional Alpine farmsteads, and breathtaking mountain scenery. Includes custom foliage, terrain textures, and ambient sounds.",
        shortDescription: "Alpine farming map with mountain scenery",
        game: "fs22",
        version: "2.0.1",
        authorName: "AlpenModder",
        tags: ["map", "european", "mountains"],
        iconUrl: IMG(5),
        gallery: [IMG(51), IMG(52)],
        accessType: "free",
        price: 0,
        unlockCode: null,
        category: "maps",
        fileSizeMb: 567.1,
        downloads: 38900,
        views: 87600,
        shares: 4300,
        featured: false,
        createdAt: "2025-03-15T10:00:00Z",
        updatedAt: "2025-12-20T08:00:00Z",
      },
      {
        title: "Livestock Pro - Animal Management",
        description:
          "Complete animal management overhaul. Adds realistic animal AI behaviors, detailed health systems, breeding mechanics, and custom animal shelters. Supports cows, sheep, pigs, chickens, and horses.",
        shortDescription:
          "Complete animal management and breeding overhaul",
        game: "fs25",
        version: "1.2.0",
        authorName: "LivestockLabs",
        tags: ["animals", "gameplay", "management"],
        iconUrl: IMG(6),
        gallery: [IMG(61)],
        accessType: "unlock_code",
        price: 300, // ₹300 (approx $3.49)
        unlockCode: "LIVE-STCK-9Z",
        category: "animals",
        fileSizeMb: 45.6,
        downloads: 19800,
        views: 52100,
        shares: 2800,
        featured: false,
        createdAt: "2025-12-01T09:00:00Z",
        updatedAt: "2026-03-01T15:00:00Z",
      },
      {
        title: "Fendt 1050 Vario",
        description:
          "The flagship Fendt 1050 Vario with 517hp engine, Variogrip tire pressure system, and fully animated Vario transmission. Interior features a working terminal display and realistic control layout.",
        shortDescription: "Flagship Fendt 1050 with Vario transmission",
        game: "fs25",
        version: "1.1.0",
        authorName: "GermanMods",
        tags: ["tractor", "fendt", "high-hp"],
        iconUrl: IMG(7),
        gallery: [IMG(71), IMG(72)],
        accessType: "free",
        price: 0,
        unlockCode: null,
        category: "vehicles",
        fileSizeMb: 178.4,
        downloads: 52100,
        views: 134500,
        shares: 6700,
        featured: true,
        createdAt: "2025-10-05T11:00:00Z",
        updatedAt: "2026-02-14T13:00:00Z",
      },
      {
        title: "Grain Storage Complex",
        description:
          "A complete grain storage facility with multiple silo types, grain dryers, conveyor systems, and truck loading bays. All buildings are placeable and can be customized in size and color.",
        shortDescription:
          "Placeable grain storage with silos and conveyors",
        game: "fs22",
        version: "1.0.3",
        authorName: "BuilderBob_FS",
        tags: ["placeable", "storage", "grain"],
        iconUrl: IMG(8),
        gallery: [IMG(81)],
        accessType: "free",
        price: 0,
        unlockCode: null,
        category: "placeables",
        fileSizeMb: 34.2,
        downloads: 31200,
        views: 67800,
        shares: 2100,
        featured: false,
        createdAt: "2025-07-22T16:00:00Z",
        updatedAt: "2025-11-30T10:00:00Z",
      },
      {
        title: "Seasons Reloaded",
        description:
          "Enhanced seasonal cycle mod with dynamic crop growth, weather events, economic fluctuations tied to seasons, and visual environment changes. A must-have for realistic gameplay.",
        shortDescription:
          "Enhanced seasonal cycle with dynamic crop growth",
        game: "fs25",
        version: "3.0.0",
        authorName: "RealFarm_Team",
        tags: ["gameplay", "seasons", "realism"],
        iconUrl: IMG(9),
        gallery: [IMG(91), IMG(92)],
        accessType: "paid", // changed from unlock_code to paid for chat demo
        price: 500, // ₹500 (approx $5.99)
        unlockCode: null,
        category: "gameplay",
        fileSizeMb: 12.8,
        downloads: 72400,
        views: 198000,
        shares: 11200,
        featured: false,
        createdAt: "2025-08-10T08:00:00Z",
        updatedAt: "2026-05-01T12:00:00Z",
      },
      {
        title: "Krone BiG X 1180 Forage Harvester",
        description:
          "The massive Krone BiG X 1180 forage harvester with 1156hp engine, multiple header options, and realistic chopping mechanics. Includes the cargo trailer addon.",
        shortDescription: "Massive Krone forage harvester with 1156hp",
        game: "fs22",
        version: "1.4.0",
        authorName: "HarvestKing",
        tags: ["harvester", "krone", "forage"],
        iconUrl: IMG(10),
        gallery: [IMG(101), IMG(102)],
        accessType: "free",
        price: 0,
        unlockCode: null,
        category: "harvesters",
        fileSizeMb: 198.7,
        downloads: 29800,
        views: 76400,
        shares: 3800,
        featured: false,
        createdAt: "2025-04-18T14:00:00Z",
        updatedAt: "2025-10-25T09:00:00Z",
      },
      {
        title: "Auto Drive Course Manager",
        description:
          "Advanced auto-drive system with route planning, field detection, and convoy support. Create custom routes between fields, sell points, and storage facilities.",
        shortDescription: "AI route planning with convoy support",
        game: "fs25",
        version: "2.3.1",
        authorName: "AutoFarm_AI",
        tags: ["gameplay", "automation", "ai"],
        iconUrl: IMG(15),
        gallery: [IMG(111)],
        accessType: "free",
        price: 0,
        unlockCode: null,
        category: "gameplay",
        fileSizeMb: 8.4,
        downloads: 95600,
        views: 223000,
        shares: 15400,
        featured: false,
        createdAt: "2025-05-30T10:00:00Z",
        updatedAt: "2026-04-20T16:00:00Z",
      },
      {
        title: "New Holland CR10.90 Revelation",
        description:
          "The New Holland CR10.90 Revelation combine with 652hp engine, 14500L grain tank, and advanced crop handling. Features Terra Trac undercarriage and IntelliView IV terminal.",
        shortDescription: "NH CR10.90 combine with Terra Trac system",
        game: "fs25",
        version: "1.0.0",
        authorName: "BlueForce_FS",
        tags: ["harvester", "new-holland", "combine"],
        iconUrl: IMG(16),
        gallery: [IMG(121), IMG(122)],
        accessType: "unlock_code",
        price: 350, // ₹350 (approx $3.99)
        unlockCode: "NHCR-10RV-5B",
        category: "harvesters",
        fileSizeMb: 267.3,
        downloads: 8900,
        views: 24500,
        shares: 890,
        featured: false,
        createdAt: "2026-02-28T09:00:00Z",
        updatedAt: "2026-05-15T14:00:00Z",
      },
    ];

    // Create mods and build an ID lookup for activity logs
    const createdMods: Array<{ id: string; title: string }> = [];

    for (const mod of modsData) {
      const authorId = authorMap[mod.authorName];
      if (!authorId) {
        throw new Error(
          `Author "${mod.authorName}" not found in modders map. Check modderData.`
        );
      }

      const created = await tx.mod.create({
        data: {
          title: mod.title,
          description: mod.description,
          shortDescription: mod.shortDescription,
          game: mod.game,
          version: mod.version,
          authorId,
          tags: mod.tags,
          iconUrl: mod.iconUrl,
          gallery: mod.gallery,
          accessType: mod.accessType,
          price: mod.price,
          unlockCode: mod.unlockCode,
          downloadUrl: `https://download.fsmodshub.com/mods/${mod.title.toLowerCase().replace(/\s+/g, "-")}.zip`,
          category: mod.category,
          fileSizeMb: mod.fileSizeMb,
          downloads: mod.downloads,
          views: mod.views,
          shares: mod.shares,
          featured: mod.featured,
          status: "published",
          createdAt: new Date(mod.createdAt),
          updatedAt: new Date(mod.updatedAt),
        },
      });

      createdMods.push({ id: created.id, title: created.title });
    }
    console.log(`  ✅ ${modsData.length} mods created`);

    // -----------------------------------------------------------------------
    // 7. Activity logs (12 entries from frontend mock data)
    //
    // We map user display names to real user IDs where possible.
    // Some activity users (FreshFarmer_01, CropQueen_88, AutoFarm_AI) may
    // not have accounts — we set userId to null for unregistered names.
    // -----------------------------------------------------------------------

    // Unified user lookup by display name
    const userLookup: Record<string, string> = {
      SEKHON: owner.id,
      Admin: admin.id,
      ...Object.fromEntries(
        Object.entries(modders).map(([name, u]) => [name, u.id])
      ),
      ...Object.fromEntries(
        Object.entries(members).map(([name, u]) => [name, u.id])
      ),
    };

    interface ActivitySeedData {
      type:
        | "download"
        | "unlock"
        | "register"
        | "upload"
        | "ban"
        | "feature"
        | "delete"
        | "review"
        | "chat"
        | "like"
        | "report";
      message: string;
      userName: string;
      createdAt: string;
    }

    const activityData: ActivitySeedData[] = [
      {
        type: "download",
        message: "Downloaded John Deere 8R Series Tractor Pack",
        userName: "Sarah Fields",
        createdAt: "2026-05-30T15:42:00Z",
      },
      {
        type: "register",
        message: "New user registered",
        userName: "FreshFarmer_01",
        createdAt: "2026-05-30T15:30:00Z",
      },
      {
        type: "unlock",
        message: "Unlocked Seasons Reloaded with code",
        userName: "Elena Crops",
        createdAt: "2026-05-30T14:58:00Z",
      },
      {
        type: "download",
        message: "Downloaded Midwest Harvest Map",
        userName: "TractorFan2000",
        createdAt: "2026-05-30T14:20:00Z",
      },
      {
        type: "feature",
        message: "Fendt 1050 Vario marked as featured",
        userName: "Admin",
        createdAt: "2026-05-30T13:45:00Z",
      },
      {
        type: "ban",
        message: "User xXModHackerXx banned for TOS violation",
        userName: "Admin",
        createdAt: "2026-05-30T12:10:00Z",
      },
      {
        type: "upload",
        message: "New mod uploaded: Auto Drive Course Manager v2.3.1",
        userName: "AutoFarm_AI",
        createdAt: "2026-05-30T11:00:00Z",
      },
      {
        type: "download",
        message: "Downloaded Bavarian Alps Map",
        userName: "John Farmer",
        createdAt: "2026-05-30T10:30:00Z",
      },
      {
        type: "unlock",
        message: "Unlocked Precision Seeder Pack with code",
        userName: "Mike Harvest",
        createdAt: "2026-05-30T09:15:00Z",
      },
      {
        type: "delete",
        message: "Removed mod: Broken Tractor v0.1 (rule violation)",
        userName: "Admin",
        createdAt: "2026-05-29T22:00:00Z",
      },
      {
        type: "register",
        message: "New user registered",
        userName: "CropQueen_88",
        createdAt: "2026-05-29T20:45:00Z",
      },
      {
        type: "download",
        message: "Downloaded Krone BiG X 1180 Forage Harvester",
        userName: "MapMaster_US",
        createdAt: "2026-05-29T18:30:00Z",
      },
    ];

    for (const activity of activityData) {
      await tx.activityLog.create({
        data: {
          type: activity.type,
          message: activity.message,
          userId: userLookup[activity.userName] ?? null,
          metadata: { userName: activity.userName },
          createdAt: new Date(activity.createdAt),
        },
      });
    }
    console.log(`  ✅ ${activityData.length} activity log entries created`);
    },
    { maxWait: 20000, timeout: 120000 }
  );

  console.log("\n🎉 Seeding complete!");
}

// ---------------------------------------------------------------------------
// Execute
// ---------------------------------------------------------------------------
main()
  .catch((error) => {
    console.error("❌ Seed failed:", error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
