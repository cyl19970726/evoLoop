import type { Pool, PoolClient } from "pg";

type Db = Pick<Pool, "query">;

type AccountRow = {
  account_id: string;
  actor_id: string;
  email: string;
  display_name: string;
  password_hash: string;
  is_hub_admin: boolean;
  created_at: Date | string;
  updated_at: Date | string;
};

type InviteRow = {
  invite_id: string;
  email: string;
  token_hash: string;
  created_by: string;
  created_at: Date | string;
  expires_at: Date | string;
  accepted_at: Date | string | null;
  accepted_by: string | null;
};

type SessionRow = {
  session_id: string;
  account_id: string;
  token_hash: string;
  created_at: Date | string;
  last_seen_at: Date | string;
  expires_at: Date | string;
  revoked_at: Date | string | null;
};

type SessionAccountRow = SessionRow & {
  actor_id: string;
  email: string;
  display_name: string;
  password_hash: string;
  is_hub_admin: boolean;
  account_created_at: Date | string;
  account_updated_at: Date | string;
};

type ProjectRow = {
  project_id: string;
  name: string;
  machine_id: string | null;
  created_by: string;
  created_at: Date | string;
  updated_at: Date | string;
};

type MemberRow = {
  project_id: string;
  account_id: string;
  actor_id: string;
  email: string;
  display_name: string;
  can_task: boolean;
  can_document: boolean;
  can_session: boolean;
  session_ids: string[];
  is_project_admin: boolean;
  created_at: Date | string;
  updated_at: Date | string;
};

type PersonalTokenRow = {
  token_id: string;
  account_id: string;
  name: string;
  token_hash: string;
  project_id: string | null;
  created_at: Date | string;
  expires_at: Date | string | null;
  last_used_at: Date | string | null;
  revoked_at: Date | string | null;
  project_name: string | null;
};

type PersonalTokenAccountRow = PersonalTokenRow & {
  actor_id: string;
  email: string;
  display_name: string;
  password_hash: string;
  is_hub_admin: boolean;
  account_created_at: Date | string;
  account_updated_at: Date | string;
};

type ServiceIdentityRow = {
  service_identity_id: string;
  actor_id: string;
  display_name: string;
  owner_account_id: string;
  purpose: string;
  token_hash: string;
  created_by: string;
  created_at: Date | string;
  revoked_at: Date | string | null;
  owner_name: string;
};

type AuditRow = {
  audit_id: string;
  occurred_at: Date | string;
  actor_kind: "human" | "service" | "system";
  actor_id: string | null;
  action: string;
  project_id: string | null;
  subject: string | null;
  detail: Record<string, unknown>;
};

const iso = (value: Date | string | null): string | null =>
  value === null ? null : value instanceof Date ? value.toISOString() : new Date(value).toISOString();

const accountOf = (row: AccountRow): Account => ({
  accountId: row.account_id,
  actorId: row.actor_id,
  email: row.email,
  displayName: row.display_name,
  passwordHash: row.password_hash,
  isHubAdmin: row.is_hub_admin,
  createdAt: iso(row.created_at)!,
  updatedAt: iso(row.updated_at)!,
});

const projectOf = (row: ProjectRow): Project => ({
  projectId: row.project_id,
  name: row.name,
  machineId: row.machine_id,
  createdBy: row.created_by,
  createdAt: iso(row.created_at)!,
  updatedAt: iso(row.updated_at)!,
});

const memberOf = (row: MemberRow): ProjectMember => ({
  projectId: row.project_id,
  accountId: row.account_id,
  actorId: row.actor_id,
  email: row.email,
  displayName: row.display_name,
  canTask: row.can_task,
  canDocument: row.can_document,
  canSession: row.can_session,
  sessionIds: row.session_ids,
  isProjectAdmin: row.is_project_admin,
  createdAt: iso(row.created_at)!,
  updatedAt: iso(row.updated_at)!,
});

export type Account = {
  accountId: string;
  actorId: string;
  email: string;
  displayName: string;
  passwordHash: string;
  isHubAdmin: boolean;
  createdAt: string;
  updatedAt: string;
};

export type Invite = {
  inviteId: string;
  email: string;
  tokenHash: string;
  createdBy: string;
  createdAt: string;
  expiresAt: string;
  acceptedAt: string | null;
  acceptedBy: string | null;
};

export type LoginSession = {
  sessionId: string;
  accountId: string;
  tokenHash: string;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
  revokedAt: string | null;
};

export type Project = {
  projectId: string;
  name: string;
  machineId: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
};

export type ProjectMember = {
  projectId: string;
  accountId: string;
  actorId: string;
  email: string;
  displayName: string;
  canTask: boolean;
  canDocument: boolean;
  canSession: boolean;
  sessionIds: string[];
  isProjectAdmin: boolean;
  createdAt: string;
  updatedAt: string;
};

export type ProjectSummary = Project & {
  membership: {
    canTask: boolean;
    canDocument: boolean;
    canSession: boolean;
    sessionIds: string[];
    isProjectAdmin: boolean;
  };
};

export type PersonalToken = {
  tokenId: string;
  accountId: string;
  name: string;
  tokenHash: string;
  projectId: string | null;
  projectName: string | null;
  createdAt: string;
  expiresAt: string | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
};

/** What a service identity may do in each project it is scoped to: nothing but read unless granted (decisions only when explicit, DEC-048). */
export type ServiceGrant = { canTask: boolean; canDocument: boolean; canSession: boolean; sessionIds: string[]; decisions: boolean };

export type ServiceIdentity = {
  serviceIdentityId: string;
  actorId: string;
  displayName: string;
  ownerAccountId: string;
  ownerName: string;
  purpose: string;
  tokenHash: string;
  createdBy: string;
  createdAt: string;
  revokedAt: string | null;
  projectIds: string[];
};

export type AuditEntry = {
  auditId: string;
  occurredAt: string;
  actorKind: "human" | "service" | "system";
  actorId: string | null;
  action: string;
  projectId: string | null;
  subject: string | null;
  detail: Record<string, unknown>;
};

export type AuditEvent = {
  at: Date;
  actorKind: "human" | "service" | "system";
  actorId: string | null;
  action: string;
  projectId?: string | null;
  subject?: string | null;
  detail?: Record<string, unknown>;
};

export class HubStore {
  constructor(readonly pool: Pool) {}

  async transaction<T>(action: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await action(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async audit(db: Db, event: AuditEvent): Promise<void> {
    await db.query(
      `INSERT INTO hub_audit(occurred_at, actor_kind, actor_id, action, project_id, subject, detail)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
      [
        event.at,
        event.actorKind,
        event.actorId,
        event.action,
        event.projectId ?? null,
        event.subject ?? null,
        JSON.stringify(event.detail ?? {}),
      ],
    );
  }

  async countHubAdmins(db: Db = this.pool): Promise<number> {
    const result = await db.query<{ count: string }>("SELECT count(*)::text AS count FROM hub_account WHERE is_hub_admin");
    return Number(result.rows[0]?.count ?? "0");
  }

  async findAccountByEmail(email: string, db: Db = this.pool): Promise<Account | null> {
    const result = await db.query<AccountRow>("SELECT * FROM hub_account WHERE email=$1", [email]);
    return result.rows[0] ? accountOf(result.rows[0]) : null;
  }

  async findAccountById(accountId: string, db: Db = this.pool): Promise<Account | null> {
    const result = await db.query<AccountRow>("SELECT * FROM hub_account WHERE account_id=$1", [accountId]);
    return result.rows[0] ? accountOf(result.rows[0]) : null;
  }

  async findAccountByIdForUpdate(client: PoolClient, accountId: string): Promise<Account | null> {
    const result = await client.query<AccountRow>("SELECT * FROM hub_account WHERE account_id=$1 FOR UPDATE", [accountId]);
    return result.rows[0] ? accountOf(result.rows[0]) : null;
  }

  async createAccount(
    client: PoolClient,
    input: { accountId: string; actorId: string; email: string; displayName: string; passwordHash: string; isHubAdmin: boolean; at: Date },
  ): Promise<Account> {
    const result = await client.query<AccountRow>(
      `INSERT INTO hub_account(account_id, actor_id, email, display_name, password_hash, is_hub_admin, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $7)
       RETURNING *`,
      [input.accountId, input.actorId, input.email, input.displayName, input.passwordHash, input.isHubAdmin, input.at],
    );
    return accountOf(result.rows[0]!);
  }

  async listAccounts(): Promise<Account[]> {
    const result = await this.pool.query<AccountRow>("SELECT * FROM hub_account ORDER BY created_at, account_id");
    return result.rows.map(accountOf);
  }

  async updateAccountPassword(client: PoolClient, accountId: string, passwordHash: string, at: Date): Promise<void> {
    await client.query("UPDATE hub_account SET password_hash=$2, updated_at=$3 WHERE account_id=$1", [accountId, passwordHash, at]);
  }

  async createInvite(
    client: PoolClient,
    input: { inviteId: string; email: string; tokenHash: string; createdBy: string; at: Date; expiresAt: Date },
  ): Promise<Invite> {
    const result = await client.query<InviteRow>(
      `INSERT INTO hub_invite(invite_id, email, token_hash, created_by, created_at, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [input.inviteId, input.email, input.tokenHash, input.createdBy, input.at, input.expiresAt],
    );
    return inviteOf(result.rows[0]!);
  }

  async findInviteByTokenHash(client: PoolClient, tokenHash: string, forUpdate = false): Promise<Invite | null> {
    const result = await client.query<InviteRow>(
      `SELECT * FROM hub_invite WHERE token_hash=$1${forUpdate ? " FOR UPDATE" : ""}`,
      [tokenHash],
    );
    return result.rows[0] ? inviteOf(result.rows[0]) : null;
  }

  async acceptInvite(client: PoolClient, inviteId: string, accountId: string, at: Date): Promise<void> {
    await client.query(
      "UPDATE hub_invite SET accepted_at=$2, accepted_by=$3 WHERE invite_id=$1 AND accepted_at IS NULL",
      [inviteId, at, accountId],
    );
  }

  async createLoginSession(
    client: PoolClient,
    input: { sessionId: string; accountId: string; tokenHash: string; at: Date; expiresAt: Date },
  ): Promise<LoginSession> {
    const result = await client.query<SessionRow>(
      `INSERT INTO hub_login_session(session_id, account_id, token_hash, created_at, last_seen_at, expires_at)
       VALUES ($1, $2, $3, $4, $4, $5)
       RETURNING *`,
      [input.sessionId, input.accountId, input.tokenHash, input.at, input.expiresAt],
    );
    return sessionOf(result.rows[0]!);
  }

  async findLoginSession(tokenHash: string, at: Date): Promise<{ session: LoginSession; account: Account } | null> {
    const result = await this.pool.query<SessionAccountRow>(
      `SELECT s.*, a.actor_id, a.email, a.display_name, a.password_hash, a.is_hub_admin,
              a.created_at AS account_created_at, a.updated_at AS account_updated_at
       FROM hub_login_session s JOIN hub_account a ON a.account_id=s.account_id
       WHERE s.token_hash=$1 AND s.revoked_at IS NULL AND s.expires_at>$2`,
      [tokenHash, at],
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      session: sessionOf(row),
      account: {
        accountId: row.account_id,
        actorId: row.actor_id,
        email: row.email,
        displayName: row.display_name,
        passwordHash: row.password_hash,
        isHubAdmin: row.is_hub_admin,
        createdAt: iso(row.account_created_at)!,
        updatedAt: iso(row.account_updated_at)!,
      },
    };
  }

  async touchLoginSession(db: Db, sessionId: string, at: Date): Promise<void> {
    await db.query("UPDATE hub_login_session SET last_seen_at=$2 WHERE session_id=$1", [sessionId, at]);
  }

  async revokeLoginSession(client: PoolClient, sessionId: string, accountId: string, at: Date): Promise<boolean> {
    const result = await client.query(
      "UPDATE hub_login_session SET revoked_at=$3 WHERE session_id=$1 AND account_id=$2 AND revoked_at IS NULL",
      [sessionId, accountId, at],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async revokeOtherLoginSessions(client: PoolClient, accountId: string, keepSessionId: string, at: Date): Promise<number> {
    const result = await client.query(
      `UPDATE hub_login_session SET revoked_at=$3
       WHERE account_id=$1 AND session_id<>$2 AND revoked_at IS NULL`,
      [accountId, keepSessionId, at],
    );
    return result.rowCount ?? 0;
  }

  async createPersonalToken(
    client: PoolClient,
    input: { tokenId: string; accountId: string; name: string; tokenHash: string; projectId: string | null; at: Date; expiresAt: Date | null },
  ): Promise<PersonalToken> {
    const result = await client.query<PersonalTokenRow>(
      `INSERT INTO hub_personal_token(token_id, account_id, name, token_hash, project_id, created_at, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *, NULL::text AS project_name`,
      [input.tokenId, input.accountId, input.name, input.tokenHash, input.projectId, input.at, input.expiresAt],
    );
    return personalTokenOf(result.rows[0]!);
  }

  async listPersonalTokens(accountId: string): Promise<PersonalToken[]> {
    const result = await this.pool.query<PersonalTokenRow>(
      `SELECT t.*, p.name AS project_name
       FROM hub_personal_token t LEFT JOIN hub_project p ON p.project_id=t.project_id
       WHERE t.account_id=$1 ORDER BY t.created_at DESC, t.token_id`,
      [accountId],
    );
    return result.rows.map(personalTokenOf);
  }

  async findPersonalToken(tokenHash: string, at: Date): Promise<{ token: PersonalToken; account: Account } | null> {
    const result = await this.pool.query<PersonalTokenAccountRow>(
      `SELECT t.*, p.name AS project_name, a.actor_id, a.email, a.display_name, a.password_hash, a.is_hub_admin,
              a.created_at AS account_created_at, a.updated_at AS account_updated_at
       FROM hub_personal_token t
       JOIN hub_account a ON a.account_id=t.account_id
       LEFT JOIN hub_project p ON p.project_id=t.project_id
       WHERE t.token_hash=$1 AND t.revoked_at IS NULL AND (t.expires_at IS NULL OR t.expires_at>$2)`,
      [tokenHash, at],
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      token: personalTokenOf(row),
      account: {
        accountId: row.account_id,
        actorId: row.actor_id,
        email: row.email,
        displayName: row.display_name,
        passwordHash: row.password_hash,
        isHubAdmin: row.is_hub_admin,
        createdAt: iso(row.account_created_at)!,
        updatedAt: iso(row.account_updated_at)!,
      },
    };
  }

  async touchPersonalToken(db: Db, tokenId: string, at: Date): Promise<void> {
    await db.query("UPDATE hub_personal_token SET last_used_at=$2 WHERE token_id=$1", [tokenId, at]);
  }

  async revokePersonalToken(client: PoolClient, tokenId: string, accountId: string, at: Date): Promise<boolean> {
    const result = await client.query(
      "UPDATE hub_personal_token SET revoked_at=$3 WHERE token_id=$1 AND account_id=$2 AND revoked_at IS NULL",
      [tokenId, accountId, at],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async createServiceIdentity(
    client: PoolClient,
    input: {
      serviceIdentityId: string;
      actorId: string;
      displayName: string;
      ownerAccountId: string;
      purpose: string;
      tokenHash: string;
      createdBy: string;
      at: Date;
      projectIds: string[];
      grant: ServiceGrant;
    },
  ): Promise<ServiceIdentity> {
    const result = await client.query<ServiceIdentityRow>(
      `INSERT INTO hub_service_identity(service_identity_id, actor_id, display_name, owner_account_id, purpose, token_hash, created_by, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *, ''::text AS owner_name`,
      [input.serviceIdentityId, input.actorId, input.displayName, input.ownerAccountId, input.purpose, input.tokenHash, input.createdBy, input.at],
    );
    for (const projectId of input.projectIds) {
      await client.query(
        `INSERT INTO hub_service_identity_project(service_identity_id, project_id, can_task, can_document, can_session, session_ids, decisions)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [input.serviceIdentityId, projectId, input.grant.canTask, input.grant.canDocument, input.grant.canSession,
          input.grant.sessionIds, input.grant.decisions],
      );
      await client.query(
        "INSERT INTO hub_project_actor(project_id, actor_id, kind) VALUES ($1, $2, 'service')",
        [projectId, input.actorId],
      );
    }
    return { ...serviceIdentityOf(result.rows[0]!), projectIds: input.projectIds };
  }

  async listServiceIdentities(): Promise<ServiceIdentity[]> {
    const identities = await this.pool.query<ServiceIdentityRow>(
      `SELECT s.*, a.display_name AS owner_name
       FROM hub_service_identity s JOIN hub_account a ON a.account_id=s.owner_account_id
       ORDER BY s.created_at, s.service_identity_id`,
    );
    const scopes = await this.pool.query<{ service_identity_id: string; project_id: string }>(
      "SELECT service_identity_id, project_id FROM hub_service_identity_project ORDER BY service_identity_id, project_id",
    );
    const byIdentity = new Map<string, Array<{ service_identity_id: string; project_id: string }>>();
    for (const scope of scopes.rows) {
      const group = byIdentity.get(scope.service_identity_id) ?? [];
      group.push(scope);
      byIdentity.set(scope.service_identity_id, group);
    }
    return identities.rows.map(row => ({
      ...serviceIdentityOf(row),
      projectIds: (byIdentity.get(row.service_identity_id) ?? []).map(scope => scope.project_id),
    }));
  }

  async findServiceIdentityByTokenHash(tokenHash: string): Promise<ServiceIdentity | null> {
    const result = await this.pool.query<ServiceIdentityRow>(
      `SELECT s.*, a.display_name AS owner_name
       FROM hub_service_identity s JOIN hub_account a ON a.account_id=s.owner_account_id
       WHERE s.token_hash=$1 AND s.revoked_at IS NULL`,
      [tokenHash],
    );
    const row = result.rows[0];
    if (!row) return null;
    const scopes = await this.pool.query<{ project_id: string }>(
      "SELECT project_id FROM hub_service_identity_project WHERE service_identity_id=$1 ORDER BY project_id",
      [row.service_identity_id],
    );
    return { ...serviceIdentityOf(row), projectIds: scopes.rows.map(scope => scope.project_id) };
  }

  async getServiceGrant(serviceIdentityId: string, projectId: string): Promise<ServiceGrant | null> {
    const result = await this.pool.query<{ can_task: boolean; can_document: boolean; can_session: boolean; session_ids: string[]; decisions: boolean }>(
      `SELECT can_task, can_document, can_session, session_ids, decisions FROM hub_service_identity_project
       WHERE service_identity_id=$1 AND project_id=$2`,
      [serviceIdentityId, projectId],
    );
    const row = result.rows[0];
    return row ? { canTask: row.can_task, canDocument: row.can_document, canSession: row.can_session, sessionIds: row.session_ids, decisions: row.decisions } : null;
  }

  async revokeServiceIdentity(client: PoolClient, serviceIdentityId: string, at: Date): Promise<boolean> {
    const result = await client.query(
      "UPDATE hub_service_identity SET revoked_at=$2 WHERE service_identity_id=$1 AND revoked_at IS NULL",
      [serviceIdentityId, at],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async createProject(
    client: PoolClient,
    input: { projectId: string; name: string; machineId: string | null; createdBy: string; at: Date },
  ): Promise<Project> {
    const result = await client.query<ProjectRow>(
      `INSERT INTO hub_project(project_id, name, machine_id, created_by, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $5) RETURNING *`,
      [input.projectId, input.name, input.machineId, input.createdBy, input.at],
    );
    return projectOf(result.rows[0]!);
  }

  async updateProject(
    client: PoolClient,
    input: { projectId: string; name: string | null; machineId: string | null; updateMachine: boolean; at: Date },
  ): Promise<Project | null> {
    const result = await client.query<ProjectRow>(
      `UPDATE hub_project SET
         name=COALESCE($2, name),
         machine_id=CASE WHEN $3 THEN $4 ELSE machine_id END,
         updated_at=$5
       WHERE project_id=$1 RETURNING *`,
      [input.projectId, input.name, input.updateMachine, input.machineId, input.at],
    );
    return result.rows[0] ? projectOf(result.rows[0]) : null;
  }

  async getProject(projectId: string): Promise<Project | null> {
    const result = await this.pool.query<ProjectRow>("SELECT * FROM hub_project WHERE project_id=$1", [projectId]);
    return result.rows[0] ? projectOf(result.rows[0]) : null;
  }

  async listProjectsForAccount(accountId: string): Promise<ProjectSummary[]> {
    const result = await this.pool.query<ProjectRow & MemberRow>(
      `SELECT p.*, m.account_id AS member_account_id, m.can_task, m.can_document, m.can_session,
              m.session_ids, m.is_project_admin, m.created_at AS member_created_at, m.updated_at AS member_updated_at
       FROM hub_project p JOIN hub_project_member m ON m.project_id=p.project_id
       WHERE m.account_id=$1 ORDER BY p.name, p.project_id`,
      [accountId],
    );
    return result.rows.map(row => ({
      ...projectOf(row),
      membership: {
        canTask: row.can_task,
        canDocument: row.can_document,
        canSession: row.can_session,
        sessionIds: row.session_ids,
        isProjectAdmin: row.is_project_admin,
      },
    }));
  }

  async listAllProjects(): Promise<Project[]> {
    const result = await this.pool.query<ProjectRow>("SELECT * FROM hub_project ORDER BY name, project_id");
    return result.rows.map(projectOf);
  }

  async listAdminProjectIds(accountId: string): Promise<string[]> {
    const result = await this.pool.query<{ project_id: string }>(
      "SELECT project_id FROM hub_project_member WHERE account_id=$1 AND is_project_admin ORDER BY project_id",
      [accountId],
    );
    return result.rows.map(row => row.project_id);
  }

  async listProjectsByIds(projectIds: string[]): Promise<Project[]> {
    if (!projectIds.length) return [];
    const result = await this.pool.query<ProjectRow>(
      "SELECT * FROM hub_project WHERE project_id = ANY($1::uuid[]) ORDER BY name, project_id",
      [projectIds],
    );
    return result.rows.map(projectOf);
  }

  async getMembership(projectId: string, accountId: string): Promise<ProjectMember | null> {
    const result = await this.pool.query<MemberRow>(
      `SELECT m.*, a.actor_id, a.email, a.display_name
       FROM hub_project_member m JOIN hub_account a ON a.account_id=m.account_id
       WHERE m.project_id=$1 AND m.account_id=$2`,
      [projectId, accountId],
    );
    return result.rows[0] ? memberOf(result.rows[0]) : null;
  }

  async listMembers(projectId: string): Promise<ProjectMember[]> {
    const result = await this.pool.query<MemberRow>(
      `SELECT m.*, a.actor_id, a.email, a.display_name
       FROM hub_project_member m JOIN hub_account a ON a.account_id=m.account_id
       WHERE m.project_id=$1 ORDER BY m.is_project_admin DESC, a.display_name, a.email`,
      [projectId],
    );
    return result.rows.map(memberOf);
  }

  async lockProject(client: PoolClient, projectId: string): Promise<Project | null> {
    const result = await client.query<ProjectRow>("SELECT * FROM hub_project WHERE project_id=$1 FOR UPDATE", [projectId]);
    return result.rows[0] ? projectOf(result.rows[0]) : null;
  }

  async getMembershipForUpdate(client: PoolClient, projectId: string, accountId: string): Promise<ProjectMember | null> {
    const result = await client.query<MemberRow>(
      `SELECT m.*, a.actor_id, a.email, a.display_name
       FROM hub_project_member m JOIN hub_account a ON a.account_id=m.account_id
       WHERE m.project_id=$1 AND m.account_id=$2 FOR UPDATE`,
      [projectId, accountId],
    );
    return result.rows[0] ? memberOf(result.rows[0]) : null;
  }

  async countProjectAdmins(client: PoolClient, projectId: string): Promise<number> {
    const result = await client.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM hub_project_member WHERE project_id=$1 AND is_project_admin",
      [projectId],
    );
    return Number(result.rows[0]?.count ?? "0");
  }

  async findProjectActor(client: PoolClient, projectId: string, actorId: string): Promise<{ kind: "human" | "service" } | null> {
    const result = await client.query<{ kind: "human" | "service" }>(
      "SELECT kind FROM hub_project_actor WHERE project_id=$1 AND actor_id=$2",
      [projectId, actorId],
    );
    return result.rows[0] ?? null;
  }

  async findProjectActorAnywhere(actorId: string): Promise<{ project_id: string; kind: "human" | "service" } | null> {
    const result = await this.pool.query<{ project_id: string; kind: "human" | "service" }>(
      "SELECT project_id, kind FROM hub_project_actor WHERE actor_id=$1 ORDER BY project_id LIMIT 1",
      [actorId],
    );
    return result.rows[0] ?? null;
  }

  async actorKindExists(client: PoolClient, actorId: string): Promise<"human" | "service" | null> {
    const human = await client.query("SELECT 1 FROM hub_account WHERE actor_id=$1", [actorId]);
    if (human.rowCount) return "human";
    const service = await client.query("SELECT 1 FROM hub_service_identity WHERE actor_id=$1", [actorId]);
    return service.rowCount ? "service" : null;
  }

  async insertProjectActor(client: PoolClient, projectId: string, actorId: string, kind: "human" | "service"): Promise<void> {
    await client.query(
      "INSERT INTO hub_project_actor(project_id, actor_id, kind) VALUES ($1, $2, $3)",
      [projectId, actorId, kind],
    );
  }

  async insertMember(
    client: PoolClient,
    input: {
      projectId: string;
      accountId: string;
      canTask: boolean;
      canDocument: boolean;
      canSession: boolean;
      sessionIds: string[];
      isProjectAdmin: boolean;
      at: Date;
    },
  ): Promise<ProjectMember> {
    const result = await client.query<MemberRow>(
      `INSERT INTO hub_project_member AS m(project_id, account_id, can_task, can_document, can_session, session_ids, is_project_admin, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8)
       RETURNING m.*, (SELECT actor_id FROM hub_account WHERE account_id=$2) AS actor_id,
                 (SELECT email FROM hub_account WHERE account_id=$2) AS email,
                 (SELECT display_name FROM hub_account WHERE account_id=$2) AS display_name`,
      [
        input.projectId,
        input.accountId,
        input.canTask,
        input.canDocument,
        input.canSession,
        input.sessionIds,
        input.isProjectAdmin,
        input.at,
      ],
    );
    return memberOf(result.rows[0]!);
  }

  async updateMember(
    client: PoolClient,
    input: {
      projectId: string;
      accountId: string;
      canTask: boolean;
      canDocument: boolean;
      canSession: boolean;
      sessionIds: string[];
      isProjectAdmin: boolean;
      at: Date;
    },
  ): Promise<ProjectMember> {
    const result = await client.query<MemberRow>(
      `UPDATE hub_project_member AS m SET can_task=$3, can_document=$4, can_session=$5, session_ids=$6,
         is_project_admin=$7, updated_at=$8
       WHERE project_id=$1 AND account_id=$2
       RETURNING m.*, (SELECT actor_id FROM hub_account WHERE account_id=$2) AS actor_id,
                 (SELECT email FROM hub_account WHERE account_id=$2) AS email,
                 (SELECT display_name FROM hub_account WHERE account_id=$2) AS display_name`,
      [input.projectId, input.accountId, input.canTask, input.canDocument, input.canSession, input.sessionIds, input.isProjectAdmin, input.at],
    );
    return memberOf(result.rows[0]!);
  }

  async deleteMember(client: PoolClient, projectId: string, accountId: string): Promise<void> {
    await client.query("DELETE FROM hub_project_member WHERE project_id=$1 AND account_id=$2", [projectId, accountId]);
    await client.query(
      `DELETE FROM hub_project_actor
       WHERE project_id=$1 AND actor_id=(SELECT actor_id FROM hub_account WHERE account_id=$2)`,
      [projectId, accountId],
    );
  }

  async getLoginThrottle(emailKey: string): Promise<{ failedCount: number; lastFailedAt: Date; blockedUntil: Date | null } | null> {
    const result = await this.pool.query<{ failed_count: number; last_failed_at: Date; blocked_until: Date | null }>(
      "SELECT failed_count, last_failed_at, blocked_until FROM hub_login_throttle WHERE email_key=$1",
      [emailKey],
    );
    const row = result.rows[0];
    return row ? { failedCount: row.failed_count, lastFailedAt: row.last_failed_at, blockedUntil: row.blocked_until } : null;
  }

  async recordLoginFailure(
    client: PoolClient,
    input: { emailKey: string; at: Date; windowStart: Date; maxFailures: number; blockedUntil: Date },
  ): Promise<number> {
    const current = await client.query<{ failed_count: number; last_failed_at: Date }>(
      "SELECT failed_count, last_failed_at FROM hub_login_throttle WHERE email_key=$1 FOR UPDATE",
      [input.emailKey],
    );
    const row = current.rows[0];
    const count = row && row.last_failed_at >= input.windowStart ? row.failed_count + 1 : 1;
    const blocked = count >= input.maxFailures ? input.blockedUntil : null;
    await client.query(
      `INSERT INTO hub_login_throttle(email_key, failed_count, last_failed_at, blocked_until)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT(email_key) DO UPDATE SET failed_count=EXCLUDED.failed_count,
         last_failed_at=EXCLUDED.last_failed_at, blocked_until=EXCLUDED.blocked_until`,
      [input.emailKey, count, input.at, blocked],
    );
    return count;
  }

  async clearLoginThrottle(client: PoolClient, emailKey: string): Promise<void> {
    await client.query("DELETE FROM hub_login_throttle WHERE email_key=$1", [emailKey]);
  }

  async listAudit(input: { projectIds: string[] | null; limit: number }): Promise<AuditEntry[]> {
    const result = await this.pool.query<AuditRow>(
      `SELECT audit_id::text, occurred_at, actor_kind, actor_id, action, project_id, subject, detail
       FROM hub_audit
       WHERE ($1::uuid[] IS NULL OR project_id = ANY($1::uuid[]))
       ORDER BY audit_id DESC LIMIT $2`,
      [input.projectIds, input.limit],
    );
    return result.rows.map(row => ({
      auditId: row.audit_id,
      occurredAt: iso(row.occurred_at)!,
      actorKind: row.actor_kind,
      actorId: row.actor_id,
      action: row.action,
      projectId: row.project_id,
      subject: row.subject,
      detail: row.detail,
    }));
  }
}

const inviteOf = (row: InviteRow): Invite => ({
  inviteId: row.invite_id,
  email: row.email,
  tokenHash: row.token_hash,
  createdBy: row.created_by,
  createdAt: iso(row.created_at)!,
  expiresAt: iso(row.expires_at)!,
  acceptedAt: iso(row.accepted_at),
  acceptedBy: row.accepted_by,
});

const sessionOf = (row: SessionRow): LoginSession => ({
  sessionId: row.session_id,
  accountId: row.account_id,
  tokenHash: row.token_hash,
  createdAt: iso(row.created_at)!,
  lastSeenAt: iso(row.last_seen_at)!,
  expiresAt: iso(row.expires_at)!,
  revokedAt: iso(row.revoked_at),
});

const personalTokenOf = (row: PersonalTokenRow): PersonalToken => ({
  tokenId: row.token_id,
  accountId: row.account_id,
  name: row.name,
  tokenHash: row.token_hash,
  projectId: row.project_id,
  projectName: row.project_name,
  createdAt: iso(row.created_at)!,
  expiresAt: iso(row.expires_at),
  lastUsedAt: iso(row.last_used_at),
  revokedAt: iso(row.revoked_at),
});

const serviceIdentityOf = (row: ServiceIdentityRow): ServiceIdentity => ({
  serviceIdentityId: row.service_identity_id,
  actorId: row.actor_id,
  displayName: row.display_name,
  ownerAccountId: row.owner_account_id,
  ownerName: row.owner_name,
  purpose: row.purpose,
  tokenHash: row.token_hash,
  createdBy: row.created_by,
  createdAt: iso(row.created_at)!,
  revokedAt: iso(row.revoked_at),
  projectIds: [],
});
