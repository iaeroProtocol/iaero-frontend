CREATE TABLE IF NOT EXISTS yield_meta(position TEXT PRIMARY KEY,revision INTEGER NOT NULL,cursors TEXT NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS yield_claims(position TEXT NOT NULL,id TEXT NOT NULL,timestamp INTEGER NOT NULL,data TEXT NOT NULL,PRIMARY KEY(position,id)) STRICT;
CREATE TABLE IF NOT EXISTS yield_snapshots(position TEXT NOT NULL,id TEXT NOT NULL,timestamp INTEGER NOT NULL,data TEXT NOT NULL,PRIMARY KEY(position,id)) STRICT;
CREATE TABLE IF NOT EXISTS yield_valuations(position TEXT NOT NULL,id TEXT NOT NULL,claimId TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(position,id),UNIQUE(position,claimId)) STRICT;
CREATE TABLE IF NOT EXISTS yield_reports(position TEXT PRIMARY KEY,data TEXT NOT NULL,updatedAt INTEGER NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS yield_leases(position TEXT PRIMARY KEY,owner TEXT NOT NULL,expiresAt INTEGER NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS yield_commit_guard(position TEXT PRIMARY KEY,valid INTEGER NOT NULL CHECK(valid=1)) STRICT;
CREATE INDEX IF NOT EXISTS yield_claim_time ON yield_claims(position,timestamp);
CREATE INDEX IF NOT EXISTS yield_snapshot_time ON yield_snapshots(position,timestamp);

CREATE TRIGGER IF NOT EXISTS yield_claims_immutable_update BEFORE UPDATE ON yield_claims WHEN NEW.data<>OLD.data OR NEW.id<>OLD.id OR NEW.position<>OLD.position BEGIN SELECT RAISE(ABORT,'immutable yield fact'); END;
CREATE TRIGGER IF NOT EXISTS yield_claims_immutable_delete BEFORE DELETE ON yield_claims BEGIN SELECT RAISE(ABORT,'immutable yield fact'); END;

CREATE TRIGGER IF NOT EXISTS yield_snapshots_immutable_update BEFORE UPDATE ON yield_snapshots WHEN NEW.data<>OLD.data OR NEW.id<>OLD.id OR NEW.position<>OLD.position BEGIN SELECT RAISE(ABORT,'immutable yield fact'); END;
CREATE TRIGGER IF NOT EXISTS yield_snapshots_immutable_delete BEFORE DELETE ON yield_snapshots BEGIN SELECT RAISE(ABORT,'immutable yield fact'); END;

CREATE TRIGGER IF NOT EXISTS yield_valuations_immutable_update BEFORE UPDATE ON yield_valuations WHEN NEW.data<>OLD.data OR NEW.id<>OLD.id OR NEW.position<>OLD.position BEGIN SELECT RAISE(ABORT,'immutable yield fact'); END;
CREATE TRIGGER IF NOT EXISTS yield_valuations_immutable_delete BEFORE DELETE ON yield_valuations BEGIN SELECT RAISE(ABORT,'immutable yield fact'); END;

CREATE TABLE IF NOT EXISTS legacy_indexes(position TEXT PRIMARY KEY,data TEXT NOT NULL,updatedAt INTEGER NOT NULL) STRICT;
