/*
 * dragon-import-core.js — pure logic for the Dragon Screenshot Import feature.
 * No DOM access here on purpose: this file is loaded both in the browser
 * (attaches everything to window.DragonImportCore) and in plain Node for
 * automated tests (module.exports), so the exact same matching/validation/
 * export logic that ships to users is what the tests actually exercise.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.DragonImportCore = api;
  }
})(typeof window !== 'undefined' ? window : this, function () {

  // ---- Validation / sanitization of the AI response ------------------------
  // Never trust arbitrary text from the model. Every field is type-checked,
  // range-clamped, or dropped to null. Unknown top-level shapes are rejected.

  function clampInt(v, min, max) {
    const n = Math.round(Number(v));
    if (!Number.isFinite(n)) return null;
    if (min != null && n < min) return null;
    if (max != null && n > max) return null;
    return n;
  }

  function clampConfidence(v) {
    const n = Number(v);
    if (!Number.isFinite(n)) return 0;
    return Math.max(0, Math.min(1, n));
  }

  function sanitizeOneDragon(raw, sourceFile) {
    raw = raw && typeof raw === 'object' ? raw : {};
    const name = typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim().slice(0, 80) : null;
    const starRank = clampInt(raw.starRank, 1, 10);
    const level = clampInt(raw.level, 1, 200);
    const maxLevel = clampInt(raw.maxLevel, 1, 200);
    const dragonId = typeof raw.dragonId === 'string' && raw.dragonId.trim() ? raw.dragonId.trim().slice(0, 64) : null;

    const confSrc = raw.confidence && typeof raw.confidence === 'object' ? raw.confidence : {};
    const confidence = {
      name: clampConfidence(confSrc.name),
      starRank: clampConfidence(confSrc.starRank),
      level: clampConfidence(confSrc.level),
      maxLevel: clampConfidence(confSrc.maxLevel),
    };

    const reviewNotes = Array.isArray(raw.reviewNotes)
      ? raw.reviewNotes.filter((n) => typeof n === 'string').slice(0, 20).map((n) => n.slice(0, 200))
      : [];

    // Auto-flag for review: missing required fields, or any present field with
    // low confidence. The model's own needsReview flag is honored but can only
    // ADD flags, never suppress ones we compute ourselves.
    const CONF_THRESHOLD = 0.6;
    let needsReview = !!raw.needsReview;
    if (!name) { needsReview = true; reviewNotes.push('Dragon name not detected.'); }
    if (starRank == null) { needsReview = true; reviewNotes.push('Star rank not detected.'); }
    if (level == null) { needsReview = true; reviewNotes.push('Level not detected.'); }
    if (name && confidence.name < CONF_THRESHOLD) { needsReview = true; reviewNotes.push('Low confidence on name.'); }
    if (starRank != null && confidence.starRank < CONF_THRESHOLD) { needsReview = true; reviewNotes.push('Low confidence on star rank.'); }
    if (level != null && confidence.level < CONF_THRESHOLD) { needsReview = true; reviewNotes.push('Low confidence on level.'); }

    return {
      name, dragonId, starRank, level, maxLevel,
      sourceFile: typeof sourceFile === 'string' ? sourceFile : (typeof raw.sourceFile === 'string' ? raw.sourceFile : ''),
      confidence, needsReview, reviewNotes,
    };
  }

  /**
   * Validates and sanitizes a raw AI response into a safe array of dragon
   * detections. Throws neither — always returns an array (possibly empty)
   * plus an `errors` list describing anything that was rejected.
   */
  function sanitizeAiResponse(rawResponse, sourceFile) {
    const errors = [];
    let parsed = rawResponse;
    if (typeof rawResponse === 'string') {
      try { parsed = JSON.parse(rawResponse); }
      catch (e) { return { dragons: [], errors: ['AI response was not valid JSON.'] }; }
    }
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.dragons)) {
      return { dragons: [], errors: ['AI response did not match the expected { dragons: [...] } shape.'] };
    }
    const dragons = parsed.dragons.slice(0, 20).map((d) => sanitizeOneDragon(d, sourceFile));
    if (parsed.dragons.length === 0) errors.push('No dragon detected in this screenshot.');
    return { dragons, errors };
  }

  // ---- Matching against the existing roster ---------------------------------

  function normalizeName(s) {
    return String(s || '').toLowerCase().trim().replace(/[^a-z0-9]/g, '');
  }

  // Small, dependency-free Levenshtein distance for conservative fuzzy matching.
  function levenshtein(a, b) {
    a = a || ''; b = b || '';
    const m = a.length, n = b.length;
    if (m === 0) return n;
    if (n === 0) return m;
    const dp = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
    for (let j = 0; j <= n; j++) dp[0][j] = j;
    for (let i = 1; i <= m; i++) {
      for (let j = 1; j <= n; j++) {
        dp[i][j] = a[i - 1] === b[j - 1]
          ? dp[i - 1][j - 1]
          : 1 + Math.min(dp[i - 1][j - 1], dp[i - 1][j], dp[i][j - 1]);
      }
    }
    return dp[m][n];
  }

  /**
   * Finds the best candidate match for a detected dragon among the existing
   * roster. Returns { dragon, matchType, score } or { dragon: null, matchType: 'none' }.
   * matchType: 'id' | 'exact' | 'case-insensitive' | 'fuzzy' | 'none'
   * Fuzzy matches are NEVER auto-applied by calling code — they're a suggestion
   * that still requires explicit user confirmation via the review table.
   */
  function matchDragon(detected, roster) {
    roster = Array.isArray(roster) ? roster : [];

    if (detected.dragonId) {
      const byId = roster.find((d) => d.id === detected.dragonId);
      if (byId) return { dragon: byId, matchType: 'id', score: 1 };
    }

    if (detected.name) {
      const exact = roster.find((d) => d.name === detected.name);
      if (exact) return { dragon: exact, matchType: 'exact', score: 1 };

      const normTarget = normalizeName(detected.name);
      const ci = roster.find((d) => normalizeName(d.name) === normTarget);
      if (ci) return { dragon: ci, matchType: 'case-insensitive', score: 0.95 };

      // Conservative fuzzy: only within a couple of edits, and only for names
      // long enough that a couple of edits is meaningfully "close" rather than
      // "coincidentally short strings collide."
      if (normTarget.length >= 4) {
        let best = null, bestDist = Infinity;
        roster.forEach((d) => {
          const dn = normalizeName(d.name);
          const dist = levenshtein(normTarget, dn);
          if (dist < bestDist) { bestDist = dist; best = d; }
        });
        const maxAllowed = normTarget.length <= 6 ? 1 : 2;
        if (best && bestDist <= maxAllowed) {
          return { dragon: best, matchType: 'fuzzy', score: 1 - bestDist / Math.max(normTarget.length, 1) };
        }
      }
    }

    return { dragon: null, matchType: 'none', score: 0 };
  }

  /**
   * Flags detected-dragon rows that look like duplicates of EACH OTHER within
   * the same import batch (e.g. the same dragon photographed twice). Returns
   * a Set of indices that are duplicates of an earlier row in the list.
   */
  function findBatchDuplicates(detectedList) {
    const seen = new Map(); // normalized name -> first index
    const dupIndices = new Set();
    detectedList.forEach((d, i) => {
      if (!d.name) return;
      const key = normalizeName(d.name);
      if (seen.has(key)) dupIndices.add(i);
      else seen.set(key, i);
    });
    return dupIndices;
  }

  // ---- Applying a reviewed row to the roster ---------------------------------

  const VALID_ACTIONS = ['add', 'update', 'skip', 'merge'];

  // ---- Default star rank (bulk apply) ----------------------------------------

  const VALID_STAR_RANKS = [5, 6, 7, 8, 9, 10];
  function isValidStarRank(v) {
    const n = Number(v);
    return VALID_STAR_RANKS.includes(n);
  }

  /**
   * Bulk-sets star rank on a roster. Pure — returns a new array, never mutates
   * the input. Only `star` (and a `starRankSource` tag) is touched; every other
   * field is preserved via spread. targetIds is optional: when omitted, every
   * dragon is updated ("apply to all"); when provided, only those ids are
   * touched (supports future "apply to selected/filtered" UI).
   * Malformed roster entries (not an object, or missing an id) are reported as
   * failures rather than thrown, so one bad record can't abort the whole batch.
   */
  function applyBulkStarRank(roster, starRank, targetIds) {
    if (!isValidStarRank(starRank)) {
      throw new Error(`Invalid star rank "${starRank}". Must be one of ${VALID_STAR_RANKS.join(', ')}.`);
    }
    const value = Number(starRank);
    const idSet = targetIds ? new Set(targetIds) : null;
    let count = 0;
    const failures = [];
    const nextRoster = roster.map((d, i) => {
      if (!d || typeof d !== 'object' || !d.id) {
        failures.push({ index: i, error: 'Malformed dragon record — skipped.' });
        return d;
      }
      if (idSet && !idSet.has(d.id)) return d;
      count++;
      return { ...d, star: value, starRankSource: 'bulk-default' };
    });
    return { roster: nextRoster, count, failures };
  }

  /**
   * Applies one reviewed row to a roster (does not mutate the input array;
   * returns { roster: newRoster, result: {action, name, dragonId} } or throws
   * a descriptive Error for an invalid row, so callers can collect per-row
   * failures without corrupting the rest of the batch.
   */
  function applyImportRow(row, roster, opts) {
    opts = opts || {};
    const makeId = opts.makeId || (() => 'imported-' + Date.now() + '-' + Math.floor(Math.random() * 100000));
    if (!VALID_ACTIONS.includes(row.action)) {
      throw new Error(`Invalid import action "${row.action}".`);
    }
    if (row.action === 'skip') {
      return { roster, result: { action: 'skipped', name: row.name || '(unknown)', dragonId: row.dragonId || null } };
    }

    if (row.action === 'add') {
      if (!row.name) throw new Error('Cannot add a dragon with no name.');
      const newDragon = {
        id: makeId(),
        name: row.name,
        rarity: 'Common',
        breed: '',
        role: 'Flexible',
        archetype: 'physical',
        damage: 'Physical',
        power: 0,
        capacity: null,
        star: row.starRank != null ? row.starRank : 1,
        reign: row.level != null ? row.level : 1,
        affinities: { spearmen: 'neutral', cavalry: 'neutral', archers: 'neutral', shieldbearers: 'neutral', siege: 'neutral' },
        affinity: { type: 'none', mode: 'neutral', amount: 0 },
        abilities: '',
        notes: 'Added via screenshot import — please verify rarity, breed, archetype, damage type and affinity.',
        skills: { selfDmgReduction: 0, rightFlankPhysicalBuff: 0, leftFlankTacticalBuff: 0, leftFlankFireBuff: 0 },
      };
      return { roster: roster.concat([newDragon]), result: { action: 'added', name: newDragon.name, dragonId: newDragon.id } };
    }

    if (row.action === 'update' || row.action === 'merge') {
      const targetId = row.matchedDragonId;
      const idx = roster.findIndex((d) => d.id === targetId);
      if (idx === -1) throw new Error(`Cannot ${row.action}: no matching dragon "${targetId}" found in roster.`);
      const existing = roster[idx];
      // Never let a null reviewed value overwrite a valid existing value.
      const updated = {
        ...existing,
        star: row.starRank != null ? row.starRank : existing.star,
        reign: row.level != null ? row.level : existing.reign,
      };
      const nextRoster = roster.slice();
      nextRoster[idx] = updated;
      return {
        roster: nextRoster,
        result: { action: row.action === 'merge' ? 'merged' : 'updated', name: existing.name, dragonId: existing.id },
      };
    }

    throw new Error('Unreachable.');
  }

  /**
   * Applies a whole batch of reviewed rows. Atomic-per-row: each row either
   * succeeds or is reported as failed, and a failed row never partially
   * mutates the roster. Successful rows ARE applied even if others fail
   * (so one bad row doesn't block importing the rest of a large batch) —
   * the caller gets a clear breakdown of which is which.
   */
  function applyImportBatch(rows, roster, opts) {
    let workingRoster = roster.slice();
    const results = [];
    const failures = [];
    rows.forEach((row, rowIndex) => {
      try {
        const { roster: nextRoster, result } = applyImportRow(row, workingRoster, opts);
        workingRoster = nextRoster;
        results.push({ ...result, rowIndex });
      } catch (e) {
        failures.push({ name: row.name || '(unknown)', error: e.message, rowIndex });
      }
    });
    return { roster: workingRoster, results, failures };
  }

  // ---- JSON export ------------------------------------------------------------

  function buildExportJson(results, exportedAtIso) {
    return {
      schemaVersion: '1.0',
      exportedAt: exportedAtIso || new Date().toISOString(),
      source: 'dragon-screenshot-import',
      dragons: results.map((r) => {
        const out = {
          name: r.name,
          dragonId: r.dragonId || null,
          starRank: r.starRank != null ? r.starRank : null,
          level: r.level != null ? r.level : null,
          maxLevel: r.maxLevel != null ? r.maxLevel : null,
          action: r.action,
        };
        // Additive only — never renames/removes the original fields above, so
        // existing consumers of this export keep working unchanged.
        if (r.starRankSource) out.starRankSource = r.starRankSource;
        if (r.detectedStarRank !== undefined) out.detectedStarRank = r.detectedStarRank;
        if (r.starRankOverridden !== undefined) out.starRankOverridden = !!r.starRankOverridden;
        return out;
      }),
    };
  }

  function exportFilename(date) {
    const d = date || new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
    return `dragons-import-${stamp}.json`;
  }

  return {
    sanitizeAiResponse,
    sanitizeOneDragon,
    normalizeName,
    levenshtein,
    matchDragon,
    findBatchDuplicates,
    applyImportRow,
    applyImportBatch,
    buildExportJson,
    exportFilename,
    VALID_ACTIONS,
    VALID_STAR_RANKS,
    isValidStarRank,
    applyBulkStarRank,
  };
});
