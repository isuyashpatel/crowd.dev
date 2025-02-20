import { DbColumnSet, DbStore, RepositoryBase } from '@crowd/database'
import { Logger } from '@crowd/logging'
import {
  getInsertMemberColumnSet,
  getInsertMemberIdentityColumnSet,
  getInsertMemberSegmentColumnSet,
  getSelectMemberColumnSet,
  getUpdateMemberColumnSet,
  IDbMember,
  IDbMemberCreateData,
  IDbMemberUpdateData,
} from './member.data'
import { IMemberIdentity, SyncStatus } from '@crowd/types'
import { generateUUIDv1 } from '@crowd/common'

export default class MemberRepository extends RepositoryBase<MemberRepository> {
  private readonly insertMemberColumnSet: DbColumnSet
  private readonly updateMemberColumnSet: DbColumnSet
  private readonly selectMemberColumnSet: DbColumnSet
  private readonly selectMemberQuery: string

  private readonly insertMemberIdentityColumnSet: DbColumnSet
  private readonly insertMemberSegmentColumnSet: DbColumnSet

  constructor(dbStore: DbStore, parentLog: Logger) {
    super(dbStore, parentLog)

    this.insertMemberColumnSet = getInsertMemberColumnSet(this.dbInstance)
    this.updateMemberColumnSet = getUpdateMemberColumnSet(this.dbInstance)
    this.selectMemberColumnSet = getSelectMemberColumnSet(this.dbInstance)

    this.selectMemberQuery = `
      select ${this.selectMemberColumnSet.columns.map((c) => `m."${c.name}"`).join(', ')}
      from "members" m
    `
    this.insertMemberIdentityColumnSet = getInsertMemberIdentityColumnSet(this.dbInstance)
    this.insertMemberSegmentColumnSet = getInsertMemberSegmentColumnSet(this.dbInstance)
  }

  public async findMemberByEmail(tenantId: string, email: string): Promise<IDbMember | null> {
    return await this.db().oneOrNone(
      `${this.selectMemberQuery}
      where "tenantId" = $(tenantId)
      and $(email) = ANY ("emails")
      limit 1
    `,
      {
        tenantId,
        email,
      },
    )
  }

  public async findMember(
    tenantId: string,
    segmentId: string,
    platform: string,
    username: string,
  ): Promise<IDbMember | null> {
    return await this.db().oneOrNone(
      `${this.selectMemberQuery}
      where m.id in (select mi."memberId"
                    from "memberIdentities" mi
                    where mi."tenantId" = $(tenantId)
                      and mi.platform = $(platform)
                      and mi.username = $(username));
    `,
      {
        tenantId,
        segmentId,
        platform,
        username,
      },
    )
  }

  public async findIdentities(
    tenantId: string,
    identities: IMemberIdentity[],
    memberId?: string,
  ): Promise<Map<string, string>> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const params: any = {
      tenantId,
    }

    let condition = ''
    if (memberId) {
      condition = 'and "memberId" <> $(memberId)'
      params.memberId = memberId
    }

    const identityParams = identities
      .map((identity) => `('${identity.platform}', '${identity.username}')`)
      .join(', ')

    const result = await this.db().any(
      `
      with input_identities (platform, username) as (
        values ${identityParams}
      )
      select "memberId", i.platform, i.username
      from "memberIdentities" mi
        inner join input_identities i on mi.platform = i.platform and mi.username = i.username
      where mi."tenantId" = $(tenantId) ${condition}
    `,
      params,
    )

    // Map the result to a Map<IMemberIdentity, string>
    const resultMap = new Map<string, string>()
    result.forEach((row) => {
      resultMap.set(`${row.platform}:${row.username}`, row.memberId)
    })

    return resultMap
  }

  public async findById(id: string): Promise<IDbMember | null> {
    return await this.db().oneOrNone(`${this.selectMemberQuery} where m.id = $(id)`, { id })
  }

  public async create(tenantId: string, data: IDbMemberCreateData): Promise<string> {
    const id = generateUUIDv1()
    const ts = new Date()
    const prepared = RepositoryBase.prepare(
      {
        ...data,
        id,
        tenantId,
        weakIdentities: JSON.stringify(data.weakIdentities || []),
        createdAt: ts,
        updatedAt: ts,
      },
      this.insertMemberColumnSet,
    )
    const query = this.dbInstance.helpers.insert(prepared, this.insertMemberColumnSet)
    await this.db().none(query)
    return id
  }

  public async update(id: string, tenantId: string, data: IDbMemberUpdateData): Promise<void> {
    const keys = Object.keys(data)
    keys.push('updatedAt')
    // construct custom column set
    const dynamicColumnSet = new this.dbInstance.helpers.ColumnSet(keys, {
      table: {
        table: 'members',
      },
    })

    const updatedAt = new Date()

    const prepared = RepositoryBase.prepare(
      {
        ...data,
        ...(data?.weakIdentities &&
          data?.weakIdentities?.length > 0 && {
            weakIdentities: JSON.stringify(data.weakIdentities),
          }),
        updatedAt,
      },
      dynamicColumnSet,
    )
    const query = this.dbInstance.helpers.update(prepared, dynamicColumnSet)

    const condition = this.format(
      'where id = $(id) and "tenantId" = $(tenantId) and "updatedAt" < $(updatedAt)',
      {
        id,
        tenantId,
        updatedAt,
      },
    )
    await this.db().result(`${query} ${condition}`)
  }

  public async getIdentities(memberId: string, tenantId: string): Promise<IMemberIdentity[]> {
    return await this.db().any(
      `
      select "sourceId", "platform", "username" from "memberIdentities"
      where "memberId" = $(memberId) and "tenantId" = $(tenantId)
    `,
      {
        memberId,
        tenantId,
      },
    )
  }

  public async removeIdentities(
    memberId: string,
    tenantId: string,
    identities: IMemberIdentity[],
  ): Promise<void> {
    const formattedIdentities = identities
      .map((i) => `('${i.platform}', '${i.username}')`)
      .join(', ')

    const query = `delete from "memberIdentities"
      where "memberId" = $(memberId) and
      "tenantId" = $(tenantId) and
      ("platform", "username") in (${formattedIdentities});
    `

    const result = await this.db().result(query, {
      memberId,
      tenantId,
      formattedIdentities,
    })

    this.checkUpdateRowCount(result.rowCount, identities.length)
  }

  public async insertIdentities(
    memberId: string,
    tenantId: string,
    integrationId: string,
    identities: IMemberIdentity[],
  ): Promise<void> {
    const objects = identities.map((i) => {
      return {
        memberId,
        tenantId,
        integrationId,
        platform: i.platform,
        sourceId: i.sourceId,
        username: i.username,
      }
    })

    const preparedObjects = RepositoryBase.prepareBatch(objects, this.insertMemberIdentityColumnSet)
    const query = this.dbInstance.helpers.insert(
      preparedObjects,
      this.insertMemberIdentityColumnSet,
    )
    await this.db().none(query)
  }

  public async addToSegment(memberId: string, tenantId: string, segmentId: string): Promise<void> {
    const prepared = RepositoryBase.prepare(
      {
        memberId,
        tenantId,
        segmentId,
      },
      this.insertMemberSegmentColumnSet,
    )

    const query =
      this.dbInstance.helpers.insert(prepared, this.insertMemberSegmentColumnSet) +
      ' ON CONFLICT DO NOTHING'
    await this.db().none(query)
  }

  public async addToSyncRemote(memberId: string, integrationId: string, sourceId: string) {
    await this.db().none(
      `insert into "membersSyncRemote" ("id", "memberId", "sourceId", "integrationId", "syncFrom", "metaData", "lastSyncedAt", "status")
      values
          ($(id), $(memberId), $(sourceId), $(integrationId), $(syncFrom), $(metaData), $(lastSyncedAt), $(status))
          on conflict do nothing`,
      {
        id: generateUUIDv1(),
        memberId,
        sourceId,
        integrationId,
        syncFrom: 'enrich',
        metaData: null,
        lastSyncedAt: null,
        status: SyncStatus.NEVER,
      },
    )
  }

  public async getMemberIdsAndEmailsAndCount(
    tenantId: string,
    segmentIds: string[],
    { limit = 20, offset = 0, orderBy = 'joinedAt_DESC', countOnly = false },
  ) {
    let orderByString = ''
    const orderByParts = orderBy.split('_')
    const direction = orderByParts[1].toLowerCase()

    switch (orderByParts[0]) {
      case 'joinedAt':
        orderByString = 'm."joinedAt"'
        break
      case 'displayName':
        orderByString = 'm."displayName"'
        break
      case 'reach':
        orderByString = "(m.reach ->> 'total')::int"
        break
      case 'score':
        orderByString = 'm.score'
        break

      default:
        throw new Error(`Invalid order by: ${orderBy}!`)
    }

    orderByString = `${orderByString} ${direction}`

    const memberCount = await this.db().one(
      `
      SELECT count(*) FROM (
        SELECT m.id
        FROM "members" m
        JOIN "memberSegments" ms ON ms."memberId" = m.id
        WHERE m."tenantId" = $(tenantId)
        AND ms."segmentId" = ANY($(segmentIds)::uuid[])
      ) as count
      `,
      {
        tenantId,
        segmentIds,
      },
    )

    if (countOnly) {
      return {
        totalCount: Number(memberCount.count),
        members: [],
      }
    }

    const members = await this.db().any(
      `
      SELECT m.id, m.emails
      FROM "members" m
      JOIN "memberSegments" ms ON ms."memberId" = m.id
      WHERE m."tenantId" = $(tenantId)
      AND ms."segmentId" = ANY($(segmentIds)::uuid[])
      ORDER BY ${orderByString}
      LIMIT $(limit) OFFSET $(offset)
      `,
      {
        tenantId,
        segmentIds,
        limit,
        offset,
      },
    )

    return {
      totalCount: Number(memberCount.count),
      members: members,
    }
  }
}
