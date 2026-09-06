/**
 * Инжест StatsBomb Open Data (https://github.com/statsbomb/open-data).
 * Даёт реальные составы, события и детальную статистику матчей.
 * Репозиторий клонируется в .cache/statsbomb (blob-less + sparse checkout).
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { getDb, setMeta } from '../server/db.js';
import { STATSBOMB_COMPETITIONS } from './competitions.js';
import { upsertTeam, resolveTeamKey } from './teams.js';
import { zonedToUtcIso, deriveStatus } from '../lib/time.js';

const SOURCE = 'statsbomb';

function readJson(repoDir, relPath, { allowGit = true } = {}) {
  const file = path.join(repoDir, relPath);
  if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  if (allowGit) {
    try {
      const out = execFileSync('git', ['-c', 'gc.auto=0', 'show', `HEAD:${relPath.replace(/\\/g, '/')}`], {
        cwd: repoDir,
        maxBuffer: 64 * 1024 * 1024,
      });
      return JSON.parse(out.toString('utf8'));
    } catch {
      return null;
    }
  }
  return null;
}

function upsertPlayer(p) {
  const db = getDb();
  const id = `sb:${p.player_id}`;
  db.prepare(
    `INSERT INTO players (id, name, nickname, position, country, statsbomb_id)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name,
       nickname = COALESCE(excluded.nickname, players.nickname),
       position = COALESCE(excluded.position, players.position),
       country = COALESCE(excluded.country, players.country)`,
  ).run(id, p.player_name, p.player_nickname || null, p.position || null, p.country || null, p.player_id);
  return id;
}
function upsertLineupRow(matchId, teamId, playerId, jersey, position, side, onMin, offMin) {
  getDb()
    .prepare(
      `INSERT INTO lineups (match_id, team_id, player_id, jersey, position, side, on_minute, off_minute)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(match_id, team_id, player_id) DO UPDATE SET
         jersey = excluded.jersey, position = excluded.position, side = excluded.side,
         on_minute = excluded.on_minute, off_minute = excluded.off_minute`,
    )
    .run(matchId, teamId, playerId, jersey, position, side, onMin, offMin);
}

function clockToMinute(value) {
  if (!value) return null;
  const m = String(value).match(/^(\d+):(\d{2})/);
  if (!m) return null;
  return Number(m[1]);
}

function ingestLineups(matchId, lineups) {
  let n = 0;
  for (const team of lineups || []) {
    const teamId = upsertTeam(team.team_name, { statsbombId: team.team_id });
    for (const p of team.lineup || []) {
      const positions = (p.positions || []).slice();
      const starting = positions.find((x) => (x.start_reason || '').startsWith('Starting XI'));
      const side = starting ? 'starting' : 'bench';
      const positionName = (starting || positions[positions.length - 1] || {}).position || null;
      let onMin = null;
      let offMin = null;
      for (const pos of positions) {
        if ((pos.start_reason || '').startsWith('Substitution - On')) onMin = clockToMinute(pos.from);
        if ((pos.end_reason || '').startsWith('Substitution - Off')) offMin = clockToMinute(pos.to);
      }
      const playerId = upsertPlayer({
        player_id: p.player_id,
        player_name: p.player_name,
        player_nickname: p.player_nickname,
        position: positionName,
        country: p.country?.name || null,
      });
      upsertLineupRow(matchId, teamId, playerId, p.jersey_number ?? null, positionName, side, onMin, offMin);
      n += 1;
    }
  }
  return n;
}

const STAT_KEYS = [
  'goals', 'shots', 'shots_on_target', 'xg', 'passes_attempted', 'passes_completed',
  'fouls_committed', 'fouls_won', 'yellow_cards', 'red_cards', 'corners', 'offsides',
  'tackles', 'saves', 'dribbles_completed', 'duels_won',
];

function blankStats() {
  return Object.fromEntries(STAT_KEYS.map((k) => [k, 0]));
}

/** Агрегирует события StatsBomb в статистику матча и таймлайн. Экспортируется для тестов. */
export function aggregateEvents(events, homeTeamId, awayTeamId, homeName, awayName) {
  const stats = {};
  const timeline = [];
  const scorers = [];
  const keyFor = (teamName) => (resolveTeamKey(teamName) === homeTeamId ? homeTeamId : awayTeamId);

  for (const ev of events || []) {
    if (!ev.team) continue;
    const teamName = ev.team.name;
    const teamKey = resolveTeamKey(teamName);
    const side = teamKey === homeTeamId ? homeTeamId : awayTeamId;
    stats[side] ||= blankStats();
    const s = stats[side];
    const type = ev.type?.name;
    const minute = ev.minute ?? null;
    const playerName = ev.player?.name || null;

    switch (type) {
      case 'Pass': {
        s.passes_attempted += 1;
        if (!ev.pass?.outcome) s.passes_completed += 1;
        if (ev.pass?.type?.name === 'Corner') s.corners += 1;
        break;
      }
      case 'Shot': {
        s.shots += 1;
        s.xg += ev.shot?.statsbomb_xg || 0;
        const outcome = ev.shot?.outcome?.name;
        if (outcome === 'Saved' || outcome === 'Blocked' || outcome === 'Goal') s.shots_on_target += 1;
        if (outcome === 'Goal') {
          s.goals += 1;
          scorers.push({ playerId: `sb:${ev.player?.id ?? ev.player?.player_id}`, teamId: side, name: playerName, kind: 'goal' });
          timeline.push({ minute, teamId: side, type: 'goal', playerId: `sb:${ev.player?.id ?? ev.player?.player_id}`, detail: playerName });
        }
        break;
      }
      case 'Penalty': {
        s.shots += 1;
        s.xg += ev.penalty?.statsbomb_xg || 0.79;
        const outcome = ev.penalty?.outcome?.name;
        if (outcome === 'Goal') {
          s.goals += 1;
          scorers.push({ playerId: `sb:${ev.player?.id ?? ev.player?.player_id}`, teamId: side, name: playerName, kind: 'penalty' });
          timeline.push({ minute, teamId: side, type: 'penalty', playerId: `sb:${ev.player?.id ?? ev.player?.player_id}`, detail: `${playerName} (пенальти)` });
        } else if (outcome) {
          timeline.push({ minute, teamId: side, type: 'miss', playerId: `sb:${ev.player?.id ?? ev.player?.player_id}`, detail: `${playerName} — пенальти не забит` });
        }
        break;
      }
      case 'Own Goal For': {
        const other = side === homeTeamId ? awayTeamId : homeTeamId;
        stats[other] ||= blankStats();
        stats[other].goals += 1;
        timeline.push({ minute, teamId: other, type: 'own_goal', playerId: `sb:${ev.player?.id ?? ev.player?.player_id}`, detail: `${playerName} (автогол)` });
        break;
      }
      case 'Foul Committed': {
        s.fouls_committed += 1;
        const card = ev.foul_committed?.card?.name;
        if (card === 'Yellow Card' || card === 'Second Yellow Card') {
          s.yellow_cards += 1;
          timeline.push({ minute, teamId: side, type: 'yellow', playerId: `sb:${ev.player?.id ?? ev.player?.player_id}`, detail: playerName });
        }
        if (card === 'Red Card') {
          s.red_cards += 1;
          timeline.push({ minute, teamId: side, type: 'red', playerId: `sb:${ev.player?.id ?? ev.player?.player_id}`, detail: playerName });
        }
        break;
      }
      case 'Foul Won':
        s.fouls_won += 1;
        break;
      case 'Duel': {
        const duelType = ev.duel?.type?.name;
        const won = ev.duel?.outcome?.name?.endsWith('Won');
        if (won) {
          s.duels_won += 1;
          if (duelType === 'Tackle') s.tackles += 1;
        }
        break;
      }
      case 'Goal Keeper':
        if (ev.goal_keeper?.type?.name === 'Shot Saved') s.saves += 1;
        break;
      case 'Dribble':
        if (ev.dribble?.outcome?.name === 'Complete') s.dribbles_completed += 1;
        break;
      case 'Offside':
        s.offsides += 1;
        break;
      case 'Substitution': {
        const replacement = ev.substitution?.replacement;
        timeline.push({
          minute,
          teamId: side,
          type: 'substitution',
          playerId: `sb:${ev.player?.id ?? ev.player?.player_id}`,
          relatedPlayerId: replacement ? `sb:${replacement.id}` : null,
          detail: `${replacement?.name || '?'} ⇄ ${playerName || '?'}`,
        });
        break;
      }
      default:
        break;
    }
  }

  const homeStats = stats[homeTeamId] || blankStats();
  const awayStats = stats[awayTeamId] || blankStats();
  const totalPossession =
    (homeStats.passes_attempted + homeStats.passes_completed) +
    (awayStats.passes_attempted + awayStats.passes_completed);
  if (totalPossession > 0) {
    homeStats.possession_pct = Math.round(
      ((homeStats.passes_attempted + homeStats.passes_completed) / totalPossession) * 100,
    );
    awayStats.possession_pct = 100 - homeStats.possession_pct;
  }
  for (const s of [homeStats, awayStats]) s.xg = Math.round(s.xg * 100) / 100;

  return {
    stats,
    timeline: timeline.filter((t) => t.minute != null).sort((a, b) => a.minute - b.minute),
    scorers,
    homeName,
    awayName,
  };
}

function writeMatchEvents(matchId, rows, knownPlayers) {
  const db = getDb();
  db.prepare('DELETE FROM match_events WHERE match_id = ?').run(matchId);
  const ensurePlayer = db.prepare('INSERT INTO players (id, name) VALUES (?, ?) ON CONFLICT(id) DO NOTHING');
  const stmt = db.prepare(
    `INSERT INTO match_events (match_id, minute, period, type, team_id, player_id, related_player_id, detail)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const validId = (id) => (id && id !== 'sb:undefined' ? id : null);
  for (const r of rows) {
    const playerId = validId(r.playerId);
    const relatedId = validId(r.relatedPlayerId);
    for (const [pid, pname] of [
      [playerId, r.detail],
      [relatedId, r.detail],
    ]) {
      if (pid && knownPlayers && !knownPlayers.has(pid)) {
        ensurePlayer.run(pid, String(pname || pid).slice(0, 120));
        knownPlayers.add(pid);
      }
    }
    stmt.run(matchId, r.minute, null, r.type, r.teamId || null, playerId, relatedId, r.detail || null);
  }
}

function writeStats(matchId, teamId, stats) {
  const db = getDb();
  for (const [key, value] of Object.entries(stats)) {
    db.prepare(
      `INSERT INTO match_stats (match_id, team_id, stat, value) VALUES (?, ?, ?, ?)
       ON CONFLICT(match_id, team_id, stat) DO UPDATE SET value = excluded.value`,
    ).run(matchId, teamId, key, Number(value));
  }
}

function upsertScorerRow(competitionId, seasonId, playerId, teamId, goals, name) {
  if (!playerId || playerId === 'sb:undefined') return;
  const db = getDb();
  db.prepare(
    `INSERT INTO players (id, name) VALUES (?, ?) ON CONFLICT(id) DO NOTHING`,
  ).run(playerId, name || playerId);
  db.prepare(
    `INSERT INTO scorers (competition_id, season_id, player_id, team_id, goals, assists, minutes)
     VALUES (?, ?, ?, ?, ?, 0, 0)
     ON CONFLICT(competition_id, season_id, player_id) DO UPDATE SET
       goals = scorers.goals + excluded.goals, team_id = COALESCE(excluded.team_id, scorers.team_id)`,
  ).run(competitionId, seasonId, playerId, teamId || null, goals);
}

export function ingestStatsbomb({ cacheDir, log = console.log, withEvents = true }) {
  const repoDir = path.join(cacheDir, 'statsbomb');
  if (!fs.existsSync(repoDir)) {
    throw new Error(`Не найден кэш StatsBomb в ${repoDir}. Запустите: npm run ingest (требуется доступ к github.com)`);
  }
  const competitions = readJson(repoDir, 'data/competitions.json');
  if (!competitions) throw new Error('StatsBomb: не удалось прочитать competitions.json');

  const db = getDb();
  let matchesTotal = 0;
  let lineupsTotal = 0;
  let eventsTotal = 0;

  for (const [pairKey, meta] of Object.entries(STATSBOMB_COMPETITIONS)) {
    const [competitionIdNum, seasonIdNum] = pairKey.split('/').map(Number);
    const info = competitions.find(
      (c) => c.competition_id === competitionIdNum && c.season_id === seasonIdNum,
    );
    if (!info) {
      log(`  statsbomb: пропущен ${pairKey} (нет в competitions.json)`);
      continue;
    }
    const compId = `${SOURCE}:${competitionIdNum}`;
    const seasonId = `${SOURCE}:${competitionIdNum}:${seasonIdNum}`;
    db.prepare(
      `INSERT INTO competitions (id, name, name_ru, country, country_ru, kind, tier, accent)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET name_ru = excluded.name_ru, accent = excluded.accent, kind = excluded.kind`,
    ).run(compId, meta.name, meta.ruComp || meta.ru || null, meta.country, meta.countryRu, meta.kind || 'league', 1, meta.accent || null);
    db.prepare(
      `INSERT INTO seasons (id, competition_id, name, label_ru, source)
       VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET label_ru = excluded.label_ru`,
    ).run(seasonId, compId, info.season_name, meta.ru, SOURCE);
    db.prepare('UPDATE competitions SET default_season_id = ? WHERE id = ? AND default_season_id IS NULL').run(seasonId, compId);

    const matches = readJson(repoDir, `data/matches/${competitionIdNum}/${seasonIdNum}.json`);
    if (!matches) {
      log(`  statsbomb: нет данных матчей для ${pairKey}`);
      continue;
    }

    for (const m of matches) {
      const matchId = `${SOURCE}:${m.match_id}`;
      const homeName = m.home_team.home_team_name;
      const awayName = m.away_team.away_team_name;
      const homeId = upsertTeam(homeName, { statsbombId: m.home_team.home_team_id, country: m.home_team.country?.name });
      const awayId = upsertTeam(awayName, { statsbombId: m.away_team.away_team_id, country: m.away_team.country?.name });
      const kickoffLocal = `${m.match_date} ${String(m.kick_off || '00:00:00').slice(0, 5)}`;
      const kickoffUtc = zonedToUtcIso(m.match_date, String(m.kick_off || '00:00').slice(0, 5), meta.tz);
      const hasScore = m.home_score != null && m.away_score != null;

      db.prepare(
        `INSERT INTO matches (
          id, competition_id, season_id, stage, round, matchday, group_name, kickoff_utc, kickoff_local, timezone,
          status, home_team_id, away_team_id, home_score, away_score,
          venue, city, country, attendance, referee, source, source_match_id, has_lineups, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          status = excluded.status,
          home_score = excluded.home_score, away_score = excluded.away_score,
          venue = excluded.venue, attendance = COALESCE(excluded.attendance, matches.attendance),
          referee = COALESCE(excluded.referee, matches.referee),
          updated_at = excluded.updated_at`,
      ).run(
        matchId, compId, seasonId, m.competition_stage?.name || null, m.competition_stage?.name || null,
        m.match_week ?? null, m.home_team.home_team_group || null,
        kickoffUtc, kickoffLocal, meta.tz, deriveStatus(kickoffUtc, hasScore),
        homeId, awayId, hasScore ? Number(m.home_score) : null, hasScore ? Number(m.away_score) : null,
        m.stadium?.name || null, null, m.stadium?.country?.name || null,
        m.attendance ?? null, m.referee?.name || null, SOURCE, String(m.match_id), 1, new Date().toISOString(),
      );
      matchesTotal += 1;

      const lineups = readJson(repoDir, `data/lineups/${m.match_id}.json`);
      const knownPlayers = new Set();
      if (lineups) {
        for (const t of lineups) for (const p of t.lineup || []) knownPlayers.add(`sb:${p.player_id}`);
        lineupsTotal += ingestLineups(matchId, lineups);
        db.prepare('UPDATE matches SET has_lineups = 1 WHERE id = ?').run(matchId);
      }

      if (withEvents && meta.withEvents) {
        const events = readJson(repoDir, `data/events/${m.match_id}.json`);
        if (events) {
          const agg = aggregateEvents(events, homeId, awayId, homeName, awayName);
          writeMatchEvents(matchId, agg.timeline, knownPlayers);
          for (const [teamId, teamStats] of Object.entries(agg.stats)) writeStats(matchId, teamId, teamStats);
          for (const g of agg.scorers) upsertScorerRow(compId, seasonId, g.playerId, g.teamId, 1, g.name);
          db.prepare('UPDATE matches SET has_stats = 1, has_events = 1 WHERE id = ?').run(matchId);
          eventsTotal += events.length;
        }
      }
    }
    log(`  statsbomb: ${meta.ru || meta.name} — ${matches.length} матчей`);
  }

  setMeta('ingest.statsbomb', new Date().toISOString());
  return { matches: matchesTotal, lineupRows: lineupsTotal, events: eventsTotal };
}
