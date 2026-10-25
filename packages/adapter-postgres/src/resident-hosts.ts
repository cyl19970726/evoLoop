import type { PoolClient } from "pg";
import type { BusinessDomain, BusinessDomainRevision, HostLink, HostLinkRevision, ResidentTransaction } from "@evoloop/contracts/resident-hosts";
import { DomainError } from "@evoloop/contracts/ports";

const iso = (value: Date | string) => typeof value === "string" ? value : value.toISOString();
const domain = (r: any): BusinessDomain => ({ projectId:r.project_id,id:r.domain_id,version:r.version,
  currentRevisionId:r.current_revision_id,title:r.title,roleId:r.role_id,routingReason:r.routing_reason,
  authorizationEvidence:r.authorization_evidence,state:r.state,actorId:r.actor_id,createdAtUtc:iso(r.created_at_utc) });
const link = (r: any): HostLink => ({ projectId:r.project_id,id:r.link_id,roleId:r.role_id,version:r.version,
  host:r.host,claimedCapabilities:r.claimed_capabilities,verifiedCapabilities:r.verified_capabilities,
  evidence:r.evidence,observer:r.observer,observedAtUtc:r.observed_at_utc ? iso(r.observed_at_utc) : null,
  state:r.state,actorId:r.actor_id,createdAtUtc:iso(r.created_at_utc) });

export class PgResidentHosts implements ResidentTransaction {
  constructor(private readonly client: PoolClient, private readonly projectId: string) {}
  async getBusinessDomain(id: string): Promise<BusinessDomain | null> {
    const r=await this.client.query(`SELECT d.project_id,d.domain_id,d.version,d.current_revision_id,d.state,
      v.title,v.role_id,v.routing_reason,v.authorization_evidence,v.actor_id,v.created_at_utc
      FROM business_domain d JOIN business_domain_revision v ON v.project_id=d.project_id AND v.domain_id=d.domain_id
      AND v.revision_id=d.current_revision_id WHERE d.project_id=$1 AND d.domain_id=$2`,[this.projectId,id]);
    return r.rows[0] ? domain(r.rows[0]) : null;
  }
  async listBusinessDomains(): Promise<BusinessDomain[]> {
    const r=await this.client.query(`SELECT d.project_id,d.domain_id,d.version,d.current_revision_id,d.state,
      v.title,v.role_id,v.routing_reason,v.authorization_evidence,v.actor_id,v.created_at_utc
      FROM business_domain d JOIN business_domain_revision v ON v.project_id=d.project_id AND v.domain_id=d.domain_id
      AND v.revision_id=d.current_revision_id WHERE d.project_id=$1 ORDER BY v.title,d.domain_id LIMIT 1001`,[this.projectId]);
    if (r.rows.length>1000) throw new Error("domain read limit exceeded");
    return r.rows.map(domain);
  }
  async listBusinessDomainRevisions(id: string): Promise<BusinessDomainRevision[]> {
    const r=await this.client.query(`SELECT v.*,v.revision_id AS current_revision_id FROM business_domain_revision v
      WHERE v.project_id=$1 AND v.domain_id=$2 ORDER BY v.version LIMIT 1001`,[this.projectId,id]);
    if (r.rows.length>1000) throw new Error("domain history read limit exceeded");
    return r.rows.map(row=>({...domain(row),reason:row.reason}));
  }
  async createBusinessDomain(value: BusinessDomain, revision: BusinessDomainRevision): Promise<void> {
    await this.client.query("INSERT INTO business_domain(project_id,domain_id,version,current_revision_id,state) VALUES($1,$2,$3,$4,$5)",
      [this.projectId,value.id,value.version,value.currentRevisionId,value.state]);
    await this.insertDomainRevision(revision);
  }
  async advanceBusinessDomain(value: BusinessDomain, expectedVersion: number, revision: BusinessDomainRevision): Promise<void> {
    const r=await this.client.query("UPDATE business_domain SET version=$3,current_revision_id=$4,state=$5 WHERE project_id=$1 AND domain_id=$2 AND version=$6",
      [this.projectId,value.id,value.version,value.currentRevisionId,value.state,expectedVersion]);
    if (r.rowCount!==1) throw new DomainError("VERSION_CONFLICT", "domain version changed");
    await this.insertDomainRevision(revision);
  }
  private async insertDomainRevision(v: BusinessDomainRevision): Promise<void> {
    await this.client.query(`INSERT INTO business_domain_revision(project_id,domain_id,revision_id,version,title,role_id,routing_reason,
      authorization_evidence,state,actor_id,reason,created_at_utc) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [this.projectId,v.id,v.currentRevisionId,v.version,v.title,v.roleId,v.routingReason,v.authorizationEvidence,v.state,v.actorId,v.reason,v.createdAtUtc]);
  }
  async getHostLink(id: string): Promise<HostLink | null> {
    const r=await this.client.query(`SELECT v.* FROM role_host_link h JOIN role_host_link_revision v ON v.project_id=h.project_id
      AND v.link_id=h.link_id AND v.version=h.version WHERE h.project_id=$1 AND h.link_id=$2`,[this.projectId,id]);
    return r.rows[0] ? link(r.rows[0]) : null;
  }
  async listHostLinks(roleId: string): Promise<HostLink[]> {
    const r=await this.client.query(`SELECT v.* FROM role_host_link h JOIN role_host_link_revision v ON v.project_id=h.project_id
      AND v.link_id=h.link_id AND v.version=h.version WHERE h.project_id=$1 AND h.role_id=$2
      ORDER BY v.created_at_utc,v.link_id LIMIT 1001`,[this.projectId,roleId]);
    if (r.rows.length>1000) throw new Error("host link read limit exceeded");
    return r.rows.map(link);
  }
  async listHostLinkRevisions(id: string): Promise<HostLinkRevision[]> {
    const r=await this.client.query("SELECT * FROM role_host_link_revision WHERE project_id=$1 AND link_id=$2 ORDER BY version LIMIT 1001",[this.projectId,id]);
    if (r.rows.length>1000) throw new Error("host link history read limit exceeded");
    return r.rows.map(row=>({...link(row),reason:row.reason}));
  }
  async createHostLink(value: HostLink, revision: HostLinkRevision): Promise<void> {
    await this.client.query("INSERT INTO role_host_link(project_id,link_id,role_id,version,state) VALUES($1,$2,$3,$4,$5)",
      [this.projectId,value.id,value.roleId,value.version,value.state]);
    await this.insertHostRevision(revision);
  }
  async advanceHostLink(value: HostLink, expectedVersion: number, revision: HostLinkRevision): Promise<void> {
    const r=await this.client.query("UPDATE role_host_link SET version=$3,state=$4 WHERE project_id=$1 AND link_id=$2 AND version=$5",
      [this.projectId,value.id,value.version,value.state,expectedVersion]);
    if (r.rowCount!==1) throw new DomainError("VERSION_CONFLICT", "host link version changed");
    await this.insertHostRevision(revision);
  }
  private async insertHostRevision(v: HostLinkRevision): Promise<void> {
    await this.client.query(`INSERT INTO role_host_link_revision(project_id,link_id,version,role_id,host,claimed_capabilities,
      verified_capabilities,evidence,observer,observed_at_utc,state,actor_id,reason,created_at_utc)
      VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7::jsonb,$8,$9,$10,$11,$12,$13,$14)`,
      [this.projectId,v.id,v.version,v.roleId,JSON.stringify(v.host),JSON.stringify(v.claimedCapabilities),
        JSON.stringify(v.verifiedCapabilities),v.evidence,v.observer,v.observedAtUtc,v.state,v.actorId,v.reason,v.createdAtUtc]);
  }
}
