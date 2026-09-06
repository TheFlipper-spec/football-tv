/**
 * Турнирные таблицы считаются по реальным сыгранным матчам из базы.
 */
import { getDb, setMeta } from '../server/db.js';

export function buildStandings({ log = console.log } = {}) {
  const db = getDb();
  db.exec('DELETE FROM standings');
  const seasons = db.prepare('SELECT DISTINCT season_id FROM matches WHERE season_id IS NOT NULL').all();

  const insert = db.prepare(
    `INSERT INTO standings (competition_id, season_id, stage, position, team_id, played, won, drawn, lost,
                            goals_for, goals_against, goal_diff, points)
     VALUES (?, ?, 'total', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  let rows = 0;
  const tx = db.prepare('BEGIN');
  const commit = db.prepare('COMMIT');
  tx.run();
  try {
    for (const { season_id: seasonId } of seasons) {
      const competitionId = db
        .prepare('SELECT competition_id FROM seasons WHERE id = ?')
        .get(seasonId)?.competition_id;
      if (!competitionId) continue;
      const matches = db
        .prepare(
          `SELECT home_team_id, away_team_id, home_score, away_score
             FROM matches
            WHERE season_id = ? AND status = 'finished'
              AND home_score IS NOT NULL AND away_score IS NOT NULL`,
        )
        .all(seasonId);
      if (!matches.length) continue;

      const table = new Map();
      const row = (teamId) => {
        if (!table.has(teamId)) {
          table.set(teamId, { teamId, played: 0, won: 0, drawn: 0, lost: 0, gf: 0, ga: 0 });
        }
        return table.get(teamId);
      };
      for (const m of matches) {
        const h = row(m.home_team_id);
        const a = row(m.away_team_id);
        h.played += 1;
        a.played += 1;
        h.gf += m.home_score;
        h.ga += m.away_score;
        a.gf += m.away_score;
        a.ga += m.home_score;
        if (m.home_score > m.away_score) {
          h.won += 1;
          a.lost += 1;
        } else if (m.home_score < m.away_score) {
          a.won += 1;
          h.lost += 1;
        } else {
          h.drawn += 1;
          a.drawn += 1;
        }
      }
      const sorted = [...table.values()].sort((x, y) => {
        const px = x.won * 3 + x.drawn;
        const py = y.won * 3 + y.drawn;
        if (py !== px) return py - px;
        const dx = x.gf - x.ga;
        const dy = y.gf - y.ga;
        if (dy !== dx) return dy - dx;
        if (y.gf !== x.gf) return y.gf - x.gf;
        return x.teamId.localeCompare(y.teamId);
      });
      sorted.forEach((r, i) => {
        insert.run(
          competitionId, seasonId, i + 1, r.teamId, r.played, r.won, r.drawn, r.lost,
          r.gf, r.ga, r.gf - r.ga, r.won * 3 + r.drawn,
        );
        rows += 1;
      });
    }
    commit.run();
  } catch (err) {
    db.prepare('ROLLBACK').run();
    throw err;
  }

  setMeta('standings.built_at', new Date().toISOString());
  log(`  таблицы: ${rows} строк`);
  return { rows };
}
