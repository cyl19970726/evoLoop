import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import type { HumanPrincipal, Principal } from "./auth.js";
import type { HubConfig } from "./config.js";
import { HubError } from "./errors.js";
import { csrfTokenFor, hashToken, newId, newToken } from "./ids.js";
import { assertPasswordPolicy, hashPassword, spendDummyPasswordCheck, verifyPassword } from "./password.js";
import type {
  Account,
  AuditEntry,
  HubStore,
  Invite,
  PersonalToken,
  Project,
  ProjectMember,
  ProjectSummary,
  ServiceIdentity,
} from "./store.js";
import {
  asRecord,
  assertMemberUsable,
  type MemberInput,
  permissionsFrom,
  sessionIdsFrom,
  textField,
  uuidField,
} from "./validation.js";

const ADMIN_INIT_LOCK = 72_834_192_552;

export type PublicAccount = Omit<Account, "passwordHash">;

export type PublicInvite = Omit<Invite, "tokenHash"> & { inviteUrl: string; token: string };

export type PublicPersonalToken = Omit<PersonalToken, "tokenHash">;

export type PublicServiceIdentity = Omit<ServiceIdentity, "tokenHash">;

export type SessionStart = {
  sessionToken: string;
  csrfToken: string;
  expiresAt: string;
  account: PublicAccount;
};

export type ProjectView = Project & {
  membership: ProjectSummary["membership"] | null;
};

const publicAccount = (account: Account): PublicAccount => {
  const { passwordHash: _passwordHash, ...rest } = account;
  return rest;
};

const publicPersonalToken = (token: PersonalToken): PublicPersonalToken => {
  const { tokenHash: _tokenHash, ...rest } = token;
  return rest;
};

const publicServiceIdentity = (identity: ServiceIdentity): PublicServiceIdentity => {
  const { tokenHash: _tokenHash, ...rest } = identity;
  return rest;
};

const publicInvite = (invite: Invite, token: string, publicOrigin: string): PublicInvite => {
  const { tokenHash: _tokenHash, ...rest } = invite;
  return {
    ...rest,
    token,
    inviteUrl: `${publicOrigin}/register?invite=${encodeURIComponent(token)}`,
  };
};

const asDate = (value: string): Date => new Date(value);

const hasOwn = (record: Record<string, unknown>, key: string): boolean => Object.prototype.hasOwnProperty.call(record, key);

const uuidList = (value: unknown, name: string, min = 1, max = 100): string[] => {
  const values = typeof value === "string" ? [value] : value;
  if (!Array.isArray(values)) throw new HubError(400, "INVALID_INPUT", `${name} must be a list of UUIDs.`);
  const unique: string[] = [];
  const seen = new Set<string>();
  for (const item of values) {
    if (typeof item !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(item)) {
      throw new HubError(400, "INVALID_ID", `${name} must contain UUIDs.`);
    }
    const normalized = item.toLowerCase();
    if (!seen.has(normalized)) {
      seen.add(normalized);
      unique.push(normalized);
    }
  }
  if (unique.length < min || unique.length > max) {
    throw new HubError(400, "INVALID_INPUT", `${name} must contain between ${min} and ${max} entries.`);
  }
  return unique;
};

export class HubService {
  constructor(
    readonly store: HubStore,
    readonly config: HubConfig,
    readonly clock: () => Date = () => new Date(),
  ) {}

  async initializeFirstAdmin(input: { email: string; displayName: string; password: string }): Promise<PublicAccount> {
    const email = input.email.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HubError(400, "INVALID_EMAIL", "Enter a valid email address.");
    if (!input.displayName.trim()) throw new HubError(400, "INVALID_INPUT", "A display name is required.");
    assertPasswordPolicy(input.password);
    const passwordHash = await hashPassword(input.password);
    const at = this.clock();
    return this.store.transaction(async client => {
      await client.query("SELECT pg_advisory_xact_lock($1)", [ADMIN_INIT_LOCK]);
      if ((await this.store.countHubAdmins(client)) > 0) {
        throw new HubError(409, "HUB_ADMIN_EXISTS", "A Hub administrator already exists; use the Hub API to create more.");
      }
      const account = await this.store.createAccount(client, {
        accountId: newId(),
        actorId: this.newHumanActorId(),
        email,
        displayName: input.displayName,
        passwordHash,
        isHubAdmin: true,
        at,
      });
      await this.store.audit(client, {
        at,
        actorKind: "system",
        actorId: "bootstrap",
        action: "hub_admin.initialized",
        subject: account.accountId,
      });
      return publicAccount(account);
    });
  }

  async createInvite(
    principal: Principal,
    input: { email: string; expiresAt: Date | null },
  ): Promise<PublicInvite> {
    const human = this.requireHubAdmin(principal);
    const email = input.email.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HubError(400, "INVALID_EMAIL", "Enter a valid email address.");
    const now = this.clock();
    const expiresAt = input.expiresAt ?? new Date(now.getTime() + this.config.inviteTtlMs);
    if (expiresAt.getTime() <= now.getTime()) throw new HubError(400, "INVALID_INPUT", "The invitation must expire in the future.");
    const token = newToken();
    const invite = await this.store.transaction(async client => {
      const created = await this.store.createInvite(client, {
        inviteId: newId(),
        email,
        tokenHash: hashToken(token),
        createdBy: human.accountId,
        at: now,
        expiresAt,
      });
      await this.store.audit(client, {
        at: now,
        actorKind: "human",
        actorId: human.actorId,
        action: "invite.created",
        subject: email,
        detail: { inviteId: created.inviteId, expiresAt: created.expiresAt },
      });
      return created;
    });
    return publicInvite(invite, token, this.config.publicOrigin);
  }

  async register(input: { inviteToken: string; password: string; displayName: string | null }): Promise<SessionStart> {
    assertPasswordPolicy(input.password);
    const passwordHash = await hashPassword(input.password);
    const now = this.clock();
    return this.store.transaction(async client => {
      const invite = await this.store.findInviteByTokenHash(client, hashToken(input.inviteToken), true);
      if (!invite) throw new HubError(404, "INVITE_INVALID", "This invitation is not valid.");
      if (invite.acceptedAt) throw new HubError(409, "INVITE_USED", "This invitation has already been used.");
      if (asDate(invite.expiresAt) <= now) throw new HubError(410, "INVITE_EXPIRED", "This invitation has expired.");
      if (await this.store.findAccountByEmail(invite.email, client)) {
        throw new HubError(409, "ACCOUNT_EXISTS", "An account with this email already exists.");
      }
      const account = await this.store.createAccount(client, {
        accountId: newId(),
        actorId: this.newHumanActorId(),
        email: invite.email,
        displayName: input.displayName ?? invite.email.split("@")[0] ?? "Member",
        passwordHash,
        isHubAdmin: false,
        at: now,
      });
      await this.store.acceptInvite(client, invite.inviteId, account.accountId, now);
      const session = await this.createSession(client, account, now);
      await this.store.audit(client, {
        at: now,
        actorKind: "human",
        actorId: account.actorId,
        action: "account.registered",
        subject: account.accountId,
        detail: { inviteId: invite.inviteId },
      });
      return session;
    });
  }

  async login(input: { email: string; password: string }): Promise<SessionStart> {
    const now = this.clock();
    const emailKey = input.email.toLowerCase();
    const throttle = await this.store.getLoginThrottle(emailKey);
    if (throttle?.blockedUntil && throttle.blockedUntil > now) {
      const retryAfterSeconds = Math.max(1, Math.ceil((throttle.blockedUntil.getTime() - now.getTime()) / 1000));
      throw new HubError(429, "LOGIN_RATE_LIMITED", "Too many failed sign-in attempts. Try again later.", { retryAfterSeconds });
    }
    const account = await this.store.findAccountByEmail(emailKey);
    if (!account) {
      await spendDummyPasswordCheck(input.password);
      await this.recordLoginFailure(emailKey, now, "unknown_account");
      throw new HubError(401, "INVALID_CREDENTIALS", "Email or password is incorrect.");
    }
    if (!(await verifyPassword(input.password, account.passwordHash))) {
      await this.recordLoginFailure(emailKey, now, "bad_password");
      throw new HubError(401, "INVALID_CREDENTIALS", "Email or password is incorrect.");
    }
    return this.store.transaction(async client => {
      await this.store.clearLoginThrottle(client, emailKey);
      const session = await this.createSession(client, account, now);
      await this.store.audit(client, {
        at: now,
        actorKind: "human",
        actorId: account.actorId,
        action: "session.login",
        subject: account.accountId,
      });
      return session;
    });
  }

  async logout(principal: Principal): Promise<void> {
    const human = this.requireCookie(principal);
    const now = this.clock();
    await this.store.transaction(async client => {
      if (human.sessionId) await this.store.revokeLoginSession(client, human.sessionId, human.accountId, now);
      await this.store.audit(client, {
        at: now,
        actorKind: "human",
        actorId: human.actorId,
        action: "session.logout",
        subject: human.accountId,
      });
    });
  }

  async changePassword(
    principal: Principal,
    input: { currentPassword: string; newPassword: string },
  ): Promise<{ revokedOtherSessions: number }> {
    const human = this.requireCookie(principal);
    if (!human.sessionId) throw new HubError(401, "SESSION_REQUIRED", "A login session is required.");
    assertPasswordPolicy(input.newPassword);
    const account = await this.store.findAccountById(human.accountId);
    if (!account || !(await verifyPassword(input.currentPassword, account.passwordHash))) {
      throw new HubError(403, "CURRENT_PASSWORD_INVALID", "The current password is incorrect.");
    }
    const passwordHash = await hashPassword(input.newPassword);
    const now = this.clock();
    return this.store.transaction(async client => {
      await this.store.updateAccountPassword(client, human.accountId, passwordHash, now);
      const revokedOtherSessions = await this.store.revokeOtherLoginSessions(client, human.accountId, human.sessionId!, now);
      await this.store.audit(client, {
        at: now,
        actorKind: "human",
        actorId: human.actorId,
        action: "account.password_changed",
        subject: human.accountId,
        detail: { revokedOtherSessions },
      });
      return { revokedOtherSessions };
    });
  }

  async createPersonalToken(
    principal: Principal,
    input: { name: string; projectId: string | null; expiresAt: Date | null },
  ): Promise<{ token: string; record: PublicPersonalToken }> {
    const human = this.requireHuman(principal);
    if (input.projectId) {
      this.requireTokenProjectScope(human, input.projectId);
      if (!(await this.store.getMembership(input.projectId, human.accountId))) {
        throw new HubError(403, "PROJECT_ACCESS_DENIED", "You are not a member of this project.");
      }
    }
    const now = this.clock();
    const token = newToken();
    const record = await this.store.transaction(async client => {
      const created = await this.store.createPersonalToken(client, {
        tokenId: newId(),
        accountId: human.accountId,
        name: input.name,
        tokenHash: hashToken(token),
        projectId: input.projectId,
        at: now,
        expiresAt: input.expiresAt,
      });
      await this.store.audit(client, {
        at: now,
        actorKind: "human",
        actorId: human.actorId,
        action: "personal_token.created",
        projectId: input.projectId,
        subject: created.tokenId,
        detail: { name: input.name, scopedProjectId: input.projectId },
      });
      return created;
    });
    return { token, record: publicPersonalToken(record) };
  }

  async listPersonalTokens(principal: Principal): Promise<PublicPersonalToken[]> {
    const human = this.requireHuman(principal);
    return (await this.store.listPersonalTokens(human.accountId)).map(publicPersonalToken);
  }

  async revokePersonalToken(principal: Principal, tokenId: string): Promise<void> {
    const human = this.requireHuman(principal);
    const now = this.clock();
    const revoked = await this.store.transaction(async client => {
      const didRevoke = await this.store.revokePersonalToken(client, tokenId, human.accountId, now);
      if (didRevoke) {
        await this.store.audit(client, {
          at: now,
          actorKind: "human",
          actorId: human.actorId,
          action: "personal_token.revoked",
          subject: tokenId,
        });
      }
      return didRevoke;
    });
    if (!revoked) throw new HubError(404, "TOKEN_NOT_FOUND", "No active personal token with that ID belongs to you.");
  }

  async createServiceIdentity(
    principal: Principal,
    input: {
      actorId: string | null;
      displayName: string;
      ownerAccountId: string;
      purpose: string;
      projectIds: string[];
    },
  ): Promise<{ token: string; identity: PublicServiceIdentity }> {
    const human = this.requireHubAdmin(principal);
    const now = this.clock();
    const actorId = input.actorId ?? `svc_${randomUUID().replaceAll("-", "").slice(0, 24)}`;
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{2,95}$/.test(actorId)) {
      throw new HubError(400, "INVALID_ACTOR_ID", "actorId must be 3-96 characters and use letters, digits, dot, underscore, colon or hyphen.");
    }
    const token = newToken();
    const identity = await this.store.transaction(async client => {
      const owner = await this.store.findAccountById(input.ownerAccountId, client);
      if (!owner) throw new HubError(404, "OWNER_NOT_FOUND", "The human owner account does not exist.");
      const existingKind = await this.store.actorKindExists(client, actorId);
      if (existingKind) {
        throw new HubError(409, "ACTOR_ID_TAKEN", "This actor ID is already used by a human or service identity.");
      }
      const projects = await this.store.listProjectsByIds(input.projectIds);
      if (projects.length !== input.projectIds.length) {
        throw new HubError(404, "PROJECT_NOT_FOUND", "One or more project scopes do not exist.");
      }
      for (const projectId of input.projectIds) {
        if (await this.store.findProjectActor(client, projectId, actorId)) {
          throw new HubError(409, "ACTOR_IDENTITY_CONFLICT", "This actor already appears in the project with the other identity kind.");
        }
      }
      const created = await this.store.createServiceIdentity(client, {
        serviceIdentityId: newId(),
        actorId,
        displayName: input.displayName,
        ownerAccountId: owner.accountId,
        purpose: input.purpose,
        tokenHash: hashToken(token),
        createdBy: human.accountId,
        at: now,
        projectIds: input.projectIds,
      });
      await this.store.audit(client, {
        at: now,
        actorKind: "human",
        actorId: human.actorId,
        action: "service_identity.created",
        subject: created.serviceIdentityId,
        detail: { actorId, ownerAccountId: owner.accountId, purpose: input.purpose, projectIds: input.projectIds },
      });
      return { ...created, ownerName: owner.displayName };
    });
    return { token, identity: publicServiceIdentity(identity) };
  }

  async listServiceIdentities(principal: Principal): Promise<PublicServiceIdentity[]> {
    this.requireHubAdmin(principal);
    return (await this.store.listServiceIdentities()).map(publicServiceIdentity);
  }

  async revokeServiceIdentity(principal: Principal, serviceIdentityId: string): Promise<void> {
    this.requireHubAdmin(principal);
    const now = this.clock();
    const revoked = await this.store.transaction(async client => {
      const didRevoke = await this.store.revokeServiceIdentity(client, serviceIdentityId, now);
      if (didRevoke) {
        await this.store.audit(client, {
          at: now,
          actorKind: "human",
          actorId: principal.actorId,
          action: "service_identity.revoked",
          subject: serviceIdentityId,
        });
      }
      return didRevoke;
    });
    if (!revoked) throw new HubError(404, "SERVICE_IDENTITY_NOT_FOUND", "No active service identity has that ID.");
  }

  async createProject(
    principal: Principal,
    input: {
      projectId: string | null;
      name: string;
      machineId: string | null;
      projectAdminAccountId: string;
      firstAdmin: MemberInput;
    },
  ): Promise<{ project: Project; firstAdmin: ProjectMember }> {
    const human = this.requireHubAdmin(principal);
    assertMemberUsable({ ...input.firstAdmin, isProjectAdmin: true });
    const now = this.clock();
    const projectId = input.projectId ?? newId();
    return this.store.transaction(async client => {
      const firstAdmin = await this.store.findAccountById(input.projectAdminAccountId, client);
      if (!firstAdmin) throw new HubError(404, "ACCOUNT_NOT_FOUND", "The first project administrator account does not exist.");
      const existing = await this.store.getProject(projectId);
      if (existing) throw new HubError(409, "PROJECT_EXISTS", "A project with this ID already exists.");
      const project = await this.store.createProject(client, {
        projectId,
        name: input.name,
        machineId: input.machineId,
        createdBy: human.accountId,
        at: now,
      });
      await this.store.insertProjectActor(client, projectId, firstAdmin.actorId, "human");
      const member = await this.store.insertMember(client, {
        projectId,
        accountId: firstAdmin.accountId,
        ...input.firstAdmin,
        isProjectAdmin: true,
        at: now,
      });
      await this.store.audit(client, {
        at: now,
        actorKind: "human",
        actorId: human.actorId,
        action: "project.created",
        projectId,
        subject: projectId,
        detail: { name: input.name, firstAdminAccountId: firstAdmin.accountId },
      });
      return { project, firstAdmin: member };
    });
  }

  async updateProject(
    principal: Principal,
    projectId: string,
    input: { name: string | null; machineId: string | null; updateMachine: boolean },
  ): Promise<Project> {
    this.requireHubAdmin(principal);
    if (input.name === null && !input.updateMachine) throw new HubError(400, "INVALID_INPUT", "Provide name or machineId.");
    const now = this.clock();
    return this.store.transaction(async client => {
      const project = await this.store.updateProject(client, {
        projectId,
        name: input.name,
        machineId: input.machineId,
        updateMachine: input.updateMachine,
        at: now,
      });
      if (!project) throw new HubError(404, "PROJECT_NOT_FOUND", "The project does not exist.");
      await this.store.audit(client, {
        at: now,
        actorKind: "human",
        actorId: principal.actorId,
        action: "project.updated",
        projectId,
        subject: projectId,
      });
      return project;
    });
  }

  async listAdminProjects(principal: Principal): Promise<Project[]> {
    this.requireHubAdmin(principal);
    return this.store.listAllProjects();
  }

  async myProjects(principal: Principal): Promise<ProjectView[]> {
    if (principal.kind === "service") {
      return (await this.store.listProjectsByIds(principal.projectIds)).map(project => ({ ...project, membership: null }));
    }
    const projects = await this.store.listProjectsForAccount(principal.accountId);
    return projects
      .filter(project => !principal.projectScope || project.projectId === principal.projectScope)
      .map(project => ({ ...project }));
  }

  async getProject(principal: Principal, projectId: string): Promise<ProjectView> {
    if (principal.kind === "service") {
      if (!principal.projectIds.includes(projectId)) throw new HubError(403, "PROJECT_ACCESS_DENIED", "This service identity is not scoped to the project.");
      const project = await this.store.getProject(projectId);
      if (!project) throw new HubError(404, "PROJECT_NOT_FOUND", "The project does not exist.");
      return { ...project, membership: null };
    }
    this.requireTokenProjectScope(principal, projectId);
    const membership = await this.store.getMembership(projectId, principal.accountId);
    if (!membership) throw new HubError(403, "PROJECT_ACCESS_DENIED", "You are not a member of this project.");
    const project = await this.store.getProject(projectId);
    if (!project) throw new HubError(404, "PROJECT_NOT_FOUND", "The project does not exist.");
    return {
      ...project,
      membership: {
        canTask: membership.canTask,
        canDocument: membership.canDocument,
        canSession: membership.canSession,
        sessionIds: membership.sessionIds,
        isProjectAdmin: membership.isProjectAdmin,
      },
    };
  }

  async listMembers(principal: Principal, projectId: string): Promise<ProjectMember[]> {
    await this.requireProjectAdmin(principal, projectId);
    return this.store.listMembers(projectId);
  }

  async addMember(principal: Principal, projectId: string, input: MemberInput & { email: string }): Promise<ProjectMember> {
    const human = this.requireHuman(principal);
    assertMemberUsable(input);
    const now = this.clock();
    return this.store.transaction(async client => {
      await this.requireProjectAdminInTransaction(client, human, projectId);
      const account = await this.store.findAccountByEmail(input.email, client);
      if (!account) throw new HubError(404, "ACCOUNT_NOT_FOUND", "No human account uses that email.");
      if (await this.store.getMembershipForUpdate(client, projectId, account.accountId)) {
        throw new HubError(409, "MEMBER_EXISTS", "This account is already a project member.");
      }
      if (await this.store.findProjectActor(client, projectId, account.actorId)) {
        throw new HubError(409, "ACTOR_IDENTITY_CONFLICT", "This actor already appears in the project with the other identity kind.");
      }
      await this.store.insertProjectActor(client, projectId, account.actorId, "human");
      const member = await this.store.insertMember(client, {
        projectId,
        accountId: account.accountId,
        canTask: input.canTask,
        canDocument: input.canDocument,
        canSession: input.canSession,
        sessionIds: input.sessionIds,
        isProjectAdmin: input.isProjectAdmin,
        at: now,
      });
      await this.store.audit(client, {
        at: now,
        actorKind: "human",
        actorId: human.actorId,
        action: "project_member.added",
        projectId,
        subject: account.accountId,
        detail: {
          canTask: input.canTask,
          canDocument: input.canDocument,
          canSession: input.canSession,
          sessionIds: input.sessionIds,
          isProjectAdmin: input.isProjectAdmin,
        },
      });
      return member;
    });
  }

  async updateMember(
    principal: Principal,
    projectId: string,
    accountId: string,
    input: MemberInput,
  ): Promise<ProjectMember> {
    const human = this.requireHuman(principal);
    assertMemberUsable(input);
    const now = this.clock();
    return this.store.transaction(async client => {
      await this.requireProjectAdminInTransaction(client, human, projectId);
      const current = await this.store.getMembershipForUpdate(client, projectId, accountId);
      if (!current) throw new HubError(404, "MEMBER_NOT_FOUND", "The project member does not exist.");
      if (current.isProjectAdmin && !input.isProjectAdmin && (await this.store.countProjectAdmins(client, projectId)) <= 1) {
        throw new HubError(409, "LAST_PROJECT_ADMIN", "The project must keep at least one project administrator.");
      }
      const member = await this.store.updateMember(client, {
        projectId,
        accountId,
        canTask: input.canTask,
        canDocument: input.canDocument,
        canSession: input.canSession,
        sessionIds: input.sessionIds,
        isProjectAdmin: input.isProjectAdmin,
        at: now,
      });
      await this.store.audit(client, {
        at: now,
        actorKind: "human",
        actorId: human.actorId,
        action: "project_member.updated",
        projectId,
        subject: accountId,
        detail: {
          canTask: input.canTask,
          canDocument: input.canDocument,
          canSession: input.canSession,
          sessionIds: input.sessionIds,
          isProjectAdmin: input.isProjectAdmin,
        },
      });
      return member;
    });
  }

  async removeMember(principal: Principal, projectId: string, accountId: string): Promise<void> {
    const human = this.requireHuman(principal);
    const now = this.clock();
    await this.store.transaction(async client => {
      await this.requireProjectAdminInTransaction(client, human, projectId);
      const current = await this.store.getMembershipForUpdate(client, projectId, accountId);
      if (!current) throw new HubError(404, "MEMBER_NOT_FOUND", "The project member does not exist.");
      if (current.isProjectAdmin && (await this.store.countProjectAdmins(client, projectId)) <= 1) {
        throw new HubError(409, "LAST_PROJECT_ADMIN", "The project must keep at least one project administrator.");
      }
      await this.store.deleteMember(client, projectId, accountId);
      await this.store.audit(client, {
        at: now,
        actorKind: "human",
        actorId: human.actorId,
        action: "project_member.removed",
        projectId,
        subject: accountId,
      });
    });
  }

  async listAccounts(principal: Principal): Promise<PublicAccount[]> {
    this.requireHubAdmin(principal);
    return (await this.store.listAccounts()).map(publicAccount);
  }

  async listAudit(principal: Principal, projectId: string | null, limit: number): Promise<AuditEntry[]> {
    let projectIds: string[] | null;
    if (principal.kind === "service") throw new HubError(403, "AUDIT_ACCESS_DENIED", "Service identities cannot read the audit log.");
    if (principal.hubAdmin) {
      if (principal.projectScope) {
        if (projectId && projectId !== principal.projectScope) {
          throw new HubError(403, "TOKEN_PROJECT_SCOPE", "This personal token is limited to another project.");
        }
        projectIds = [principal.projectScope];
      } else {
        projectIds = projectId ? [projectId] : null;
      }
    } else {
      if (projectId) {
        this.requireTokenProjectScope(principal, projectId);
        await this.requireProjectAdmin(principal, projectId);
        projectIds = [projectId];
      } else {
        projectIds = await this.store.listAdminProjectIds(principal.accountId);
        if (principal.projectScope) projectIds = projectIds.filter(id => id === principal.projectScope);
        if (!projectIds.length) throw new HubError(403, "AUDIT_ACCESS_DENIED", "Project administrators may read their project audit only.");
      }
    }
    return this.store.listAudit({ projectIds, limit });
  }

  publicAccount(account: Account): PublicAccount {
    return publicAccount(account);
  }

  private async createSession(client: PoolClient, account: Account, now: Date): Promise<SessionStart> {
    const token = newToken();
    const expiresAt = new Date(now.getTime() + this.config.sessionTtlMs);
    await this.store.createLoginSession(client, {
      sessionId: newId(),
      accountId: account.accountId,
      tokenHash: hashToken(token),
      at: now,
      expiresAt,
    });
    return {
      sessionToken: token,
      csrfToken: csrfTokenFor(token),
      expiresAt: expiresAt.toISOString(),
      account: publicAccount(account),
    };
  }

  private async recordLoginFailure(emailKey: string, now: Date, reason: "unknown_account" | "bad_password"): Promise<void> {
    await this.store.transaction(async client => {
      await this.store.recordLoginFailure(client, {
        emailKey,
        at: now,
        windowStart: new Date(now.getTime() - this.config.loginWindowMs),
        maxFailures: this.config.loginMaxFailures,
        blockedUntil: new Date(now.getTime() + this.config.loginBlockMs),
      });
      await this.store.audit(client, {
        at: now,
        actorKind: "system",
        actorId: null,
        action: "session.login_failed",
        subject: emailKey,
        detail: { reason },
      });
    });
  }

  private requireHuman(principal: Principal): HumanPrincipal {
    if (principal.kind !== "human") throw new HubError(403, "HUMAN_ACCOUNT_REQUIRED", "This action requires a human account.");
    return principal;
  }

  private requireCookie(principal: Principal): HumanPrincipal {
    const human = this.requireHuman(principal);
    if (human.auth !== "cookie" || !human.sessionId) {
      throw new HubError(403, "COOKIE_SESSION_REQUIRED", "This action requires a browser login session, not a personal token.");
    }
    return human;
  }

  private requireHubAdmin(principal: Principal): HumanPrincipal {
    const human = this.requireHuman(principal);
    if (!human.hubAdmin) throw new HubError(403, "HUB_ADMIN_REQUIRED", "Hub administrator permission is required.");
    if (human.projectScope) {
      throw new HubError(403, "TOKEN_PROJECT_SCOPE", "A project-scoped personal token cannot use Hub administration.");
    }
    return human;
  }

  private requireTokenProjectScope(principal: HumanPrincipal, projectId: string | null): void {
    if (principal.projectScope && principal.projectScope !== projectId) {
      throw new HubError(403, "TOKEN_PROJECT_SCOPE", "This personal token is limited to another project.");
    }
  }

  private async requireProjectAdmin(principal: Principal, projectId: string): Promise<ProjectMember> {
    const human = this.requireHuman(principal);
    this.requireTokenProjectScope(human, projectId);
    const membership = await this.store.getMembership(projectId, human.accountId);
    if (!membership?.isProjectAdmin) {
      throw new HubError(403, "PROJECT_ADMIN_REQUIRED", "Project administrator permission is required.");
    }
    return membership;
  }

  private async requireProjectAdminInTransaction(
    client: PoolClient,
    principal: HumanPrincipal,
    projectId: string,
  ): Promise<ProjectMember> {
    this.requireTokenProjectScope(principal, projectId);
    const project = await this.store.lockProject(client, projectId);
    if (!project) throw new HubError(404, "PROJECT_NOT_FOUND", "The project does not exist.");
    const membership = await this.store.getMembershipForUpdate(client, projectId, principal.accountId);
    if (!membership?.isProjectAdmin) {
      throw new HubError(403, "PROJECT_ADMIN_REQUIRED", "Project administrator permission is required.");
    }
    return membership;
  }

  private newHumanActorId(): string {
    return `acct_${randomUUID().replaceAll("-", "").slice(0, 24)}`;
  }
}

export function parseMemberBody(body: unknown, options: { defaultPermissions?: boolean; defaultAdmin?: boolean } = {}): MemberInput {
  const record = asRecord(body);
  const permissions = permissionsFrom(record, options.defaultPermissions ?? false);
  return {
    ...permissions,
    sessionIds: sessionIdsFrom(record.sessionIds),
    isProjectAdmin: options.defaultAdmin === true ? true : Boolean(record.isProjectAdmin === true || record.isProjectAdmin === "true" || record.isProjectAdmin === "on"),
  };
}

export function parseInviteBody(body: unknown): { email: string; expiresAt: string | null } {
  const record = asRecord(body);
  return {
    email: textField(record, "email", { min: 3, max: 320 }).toLowerCase(),
    expiresAt: typeof record.expiresAt === "string" ? record.expiresAt : null,
  };
}

export function parseProjectBody(body: unknown): {
  projectId: string | null;
  name: string;
  machineId: string | null;
  projectAdminAccountId: string;
  firstAdmin: MemberInput;
} {
  const record = asRecord(body);
  const projectId = typeof record.projectId === "string" && record.projectId ? uuidField(record, "projectId") : null;
  return {
    projectId,
    name: textField(record, "name", { min: 1, max: 200 }),
    machineId: typeof record.machineId === "string" && record.machineId.trim() ? record.machineId.trim() : null,
    projectAdminAccountId: uuidField(record, "projectAdminAccountId"),
    firstAdmin: parseMemberBody(record, { defaultPermissions: true, defaultAdmin: true }),
  };
}

export function parseServiceIdentityBody(body: unknown): {
  actorId: string | null;
  displayName: string;
  ownerAccountId: string;
  purpose: string;
  projectIds: string[];
} {
  const record = asRecord(body);
  return {
    actorId: typeof record.actorId === "string" && record.actorId.trim() ? record.actorId.trim() : null,
    displayName: textField(record, "displayName", { min: 1, max: 120 }),
    ownerAccountId: uuidField(record, "ownerAccountId"),
    purpose: textField(record, "purpose", { min: 1, max: 500 }),
    projectIds: uuidList(record.projectIds, "projectIds"),
  };
}

export function parseTokenBody(body: unknown): { name: string; projectId: string | null; expiresAt: string | null } {
  const record = asRecord(body);
  return {
    name: textField(record, "name", { min: 1, max: 120 }),
    projectId: typeof record.projectId === "string" && record.projectId ? uuidField(record, "projectId") : null,
    expiresAt: typeof record.expiresAt === "string" ? record.expiresAt : null,
  };
}

export function parseAuditLimit(value: unknown): number {
  if (value === undefined || value === null || value === "") return 100;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 500) {
    throw new HubError(400, "INVALID_LIMIT", "limit must be an integer between 1 and 500.");
  }
  return parsed;
}

export function hasMachineField(body: unknown): boolean {
  return hasOwn(asRecord(body), "machineId");
}
