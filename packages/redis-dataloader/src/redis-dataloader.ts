import DataLoader, { BatchLoadFn } from 'dataloader';
import assert from 'assert';
import { CustomNotFound, RedisDataloaderOptionsRequired } from './interfaces';
import { NotFoundError } from '@daryl-software/error';
import { Cluster, Redis } from 'ioredis';

export class RedisDataLoader<K, V, C = K> extends DataLoader<K, V, C> {
    public static checkForDuplicates = true;
    private static usedNames: Set<string> = new Set([]);
    private static NOT_FOUND_STRING = '___NOTFOUND___';

    constructor(
        override readonly name: string,
        // undefined values will be converted to not found errors
        private readonly underlyingBatchLoadFn: BatchLoadFn<K, V | undefined>,
        private readonly options: DataLoader.Options<K, V, C> & CustomNotFound<K> & RedisDataloaderOptionsRequired<K, V>
    ) {
        super((keys) => this.overridedBatchLoad(keys), { ...options, cache: false });
        this.name += options.redis.suffix ? `-${options.redis.suffix}` : '';
        if (RedisDataLoader.checkForDuplicates) {
            assert(!RedisDataLoader.usedNames.has(this.name), `RedisDataLoader name ${this.name} already used`);
            this.log(`New RedisDataLoader ${this.name}`);
        }
        RedisDataLoader.usedNames.add(this.name);
    }

    /**
     * @deprecated use clearAsync() instead
     */
    override clear(key: K): this {
        this.clearAsync(key);
        return this;
    }

    async clearAsync(...keys: K[]): Promise<number> {
        assert(keys.length, new Error('Empty array passed'));
        return Promise.all(keys.map((key) => this.options.redis.client.del(this.redisKey(key)))).then((res) => res.reduce((acc, curr) => acc + curr, 0));
    }

    async exist(key: K): Promise<boolean> {
        const lua = `
        if redis.call('exists', KEYS[1]) == 1 then
            if redis.call('get', KEYS[1]) ~= '${RedisDataLoader.NOT_FOUND_STRING}' then
                return true
            else
                return '${RedisDataLoader.NOT_FOUND_STRING}'
            end
        else
            return nil
        end`;

        this.options.redis.client.defineCommand('exist', {
            numberOfKeys: 1,
            lua,
        });
        const result = await (this.options.redis.client as (Redis | Cluster) & Record<'exist', (key: string) => Promise<boolean | '___NOTFOUND___'>>).exist(this.redisKey(key));
        if (result !== null) {
            return Promise.resolve(result !== RedisDataLoader.NOT_FOUND_STRING);
        }
        return this.load(key)
            .then((value) => value !== undefined)
            .catch((error) => {
                if (error instanceof NotFoundError) {
                    return false;
                }
                throw error;
            });
    }

    /**
     * @deprecated use clearAllAsync() instead
     */
    override clearAll(): this {
        throw new Error('Cannot call clearAll on RedisDataLoader (use clearAllAsync)');
    }

    protected log(...args: unknown[]) {
        this.options.redis.logging?.(...args);
    }

    protected async overridedBatchLoad(keys: readonly K[]): Promise<(V | Error)[]> {
        /**
         * When the memoization cache is disabled,
         * your batch function will receive an array of keys which may contain duplicates!
         * Each key will be associated with each call to .load().
         * Your batch loader should provide a value for each instance of the requested key.
         *
         * Hence why we are deduplicating first
         */
        const uniqueRedisKeys = [...new Set(keys.map((key) => this.redisKey(key)))];
        const mapRedisKeyToModelKey: { redisKey: string; key: K; value: V | undefined | Error }[] = uniqueRedisKeys.map((rKey) => ({
            redisKey: rKey,
            key: keys.find((o) => this.redisKey(o) === rKey)!,
            value: undefined,
        }));

        // ⚠️ Cannot use MGET on a cluster
        // load cached values
        if (this.options.redis.logging) {
            this.log(`Reading keys from redis: ${mapRedisKeyToModelKey.map((x) => x.redisKey).join(', ')}`);
        }
        await Promise.all(
            mapRedisKeyToModelKey.map((entry) =>
                this.options.redis.client.get(entry.redisKey).then((data) => {
                    if (data === RedisDataLoader.NOT_FOUND_STRING) {
                        entry.value = this.options.notFound?.(entry.key) ?? new NotFoundError(entry.key, 'Not found (redis cache)');
                    } else if (data !== null) {
                        entry.value = this.options.redis.deserialize(entry.key, data);
                    }
                })
            )
        );
        // this.log('map was', JSON.stringify(mapRedisKeyToModelKey));
        // keysToLoadFromDatasource is referencing mapRedisKeyToModelKey values
        const keysToLoadFromDatasource = mapRedisKeyToModelKey.filter(({ value }) => value === undefined);
        // load missing values from datastore
        if (keysToLoadFromDatasource.length > 0) {
            this.log(
                'Loading from datasource',
                keysToLoadFromDatasource.map(({ redisKey }) => redisKey)
            );
            const underlyingResults = await this.underlyingBatchLoadFn(keysToLoadFromDatasource.map(({ key }) => key));

            // Save freshly fetched data to redis
            await Promise.all(
                keysToLoadFromDatasource.map((entry, index) => {
                    // actually editing the reference (mapRedisKeyToModelKey)
                    entry.value = underlyingResults[index];
                    if (entry.value === undefined || entry.value instanceof NotFoundError) {
                        return this.storeNotFoundError(entry.redisKey);
                    }
                    if (!(entry.value instanceof Error)) {
                        return this.store(entry.redisKey, entry.value);
                    }
                    return true;
                })
            );
        }

        this.log('map to be returned', mapRedisKeyToModelKey);
        return keys.map((key) => mapRedisKeyToModelKey.find(({ redisKey }) => redisKey === this.redisKey(key))?.value ?? this.options.notFound?.(key) ?? new NotFoundError(key, 'Not found'));
    }

    private redisKey(key: K): string {
        return `${this.name}:${this.options.cacheKeyFn ? this.options.cacheKeyFn(key) : key}`;
    }

    override prime(key: K, value: Error | V) {
        void this.primeAsync(key, value);
        return this;
    }

    primeAsync(key: K, value: Error | V): Promise<boolean> {
        if (!(value instanceof Error)) {
            return this.store(this.redisKey(key), value);
        }
        return Promise.resolve(false);
    }

    private store(rKey: string, value: V): Promise<boolean> {
        const rValue = this.options.redis.serialize(value);
        this.log('saving to redis', rKey, rValue, typeof rValue);
        return this.options.redis.client.set(rKey, rValue, 'EX', this.options.redis.ttl).then((result) => result === 'OK');
    }

    private storeNotFoundError(rKey: string): Promise<boolean> {
        this.log('saving not found error to redis', rKey);
        return this.options.redis.client.set(rKey, RedisDataLoader.NOT_FOUND_STRING, 'EX', this.options.redis.ttlNotFound ?? 60).then((result) => result === 'OK');
    }

    /**
     * Load a value only if cached
     * @param keys
     */
    async loadCached(...keys: K[]) {
        const datas = await Promise.all(keys.map((key) => this.options.redis.client.get(this.redisKey(key))));
        return datas.map((data, idx) => {
            const cached = data !== null;
            let value = null;
            if (data === RedisDataLoader.NOT_FOUND_STRING) {
                value = this.options.notFound?.(keys[idx]) ?? new NotFoundError(keys[idx], 'Not found (redis cache)');
            } else if (cached) {
                value = this.options.redis.deserialize(keys[idx], data);
            }
            return { cached, value };
        });
    }
}
