// Only transient screen notifications are expired here. Business records are retained.
export async function operationalMaintenance(db){
 await db.query("DELETE FROM operational_events WHERE id IN (SELECT id FROM operational_events WHERE created_at<now()-interval '2 days' ORDER BY id LIMIT 10000)");
 await db.query("DELETE FROM worker_health WHERE heartbeat<now()-interval '1 day'");
 await db.query("UPDATE label_export_jobs SET status='failed',state=state||'{\"error\":\"Téléchargement expiré : relancer la préparation\"}'::jsonb WHERE status='pending' AND expires_at<now()");
}
