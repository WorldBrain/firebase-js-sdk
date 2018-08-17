/**
 * Copyright 2018 Google Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { Code, FirestoreError } from '../util/error';
import { ListenSequence } from '../core/listen_sequence';
import {
  BatchId,
  MutationBatchState,
  OnlineState,
  TargetId,
  ListenSequenceNumber
} from '../core/types';
import { assert } from '../util/assert';
import { debug, error } from '../util/log';
import { SortedSet } from '../util/sorted_set';
import { isSafeInteger } from '../util/types';
import * as objUtils from '../util/obj';
import { User } from '../auth/user';
import {
  QueryTargetState,
  SharedClientStateSyncer
} from './shared_client_state_syncer';
import { AsyncQueue } from '../util/async_queue';
import { Platform } from '../platform/platform';
import { TargetIdSet, targetIdSet } from '../model/collections';

const LOG_TAG = 'SharedClientState';

// The format of the LocalStorage key that stores the client state is:
//     firestore_clients_<persistence_prefix>_<instance_key>
const CLIENT_STATE_KEY_PREFIX = 'firestore_clients';

// The format of the LocalStorage key that stores the mutation state is:
//     firestore_mutations_<persistence_prefix>_<batch_id>
//     (for unauthenticated users)
// or: firestore_mutations_<persistence_prefix>_<batch_id>_<user_uid>
//
// 'user_uid' is last to avoid needing to escape '_' characters that it might
// contain.
const MUTATION_BATCH_KEY_PREFIX = 'firestore_mutations';

// The format of the LocalStorage key that stores a query target's metadata is:
//     firestore_targets_<persistence_prefix>_<target_id>
const QUERY_TARGET_KEY_PREFIX = 'firestore_targets';

// The LocalStorage key that stores the primary tab's online state.
const ONLINE_STATE_KEY = 'firestore_online_state';
// The LocalStorage key that stores the last sequence number allocated.
const SEQUENCE_NUMBER_KEY = 'firestore_sequence_number';

/**
 * A randomly-generated key assigned to each Firestore instance at startup.
 */
export type ClientId = string;

/**
 * A `SharedClientState` keeps track of the global state of the mutations
 * and query targets for all active clients with the same persistence key (i.e.
 * project ID and FirebaseApp name). It relays local changes to other clients
 * and updates its local state as new state is observed.
 *
 * `SharedClientState` is primarily used for synchronization in Multi-Tab
 * environments. Each tab is responsible for registering its active query
 * targets and mutations. `SharedClientState` will then notify the listener
 * assigned to `.syncEngine` for updates to mutations and queries that
 * originated in other clients.
 *
 * To receive notifications, `.syncEngine` and `.onlineStateHandler` has to be
 * assigned before calling `start()`.
 */
export interface SharedClientState {
  syncEngine: SharedClientStateSyncer | null;
  onlineStateHandler: (onlineState: OnlineState) => void;

  /** Registers the Mutation Batch ID of a newly pending mutation. */
  addPendingMutation(batchId: BatchId): void;

  /**
   * Records that a pending mutation has been acknowledged or rejected.
   * Called by the primary client to notify secondary clients of mutation
   * results as they come back from the backend.
   */
  updateMutationState(
    batchId: BatchId,
    state: 'acknowledged' | 'rejected',
    error?: FirestoreError
  ): void;

  /**
   * Associates a new Query Target ID with the local Firestore client. Returns
   * the new query state for the query (which can be 'current' if the query is
   * already associated with another tab).
   */
  addLocalQueryTarget(targetId: TargetId): QueryTargetState;

  /** Removes the Query Target ID association from the local client. */
  removeLocalQueryTarget(targetId: TargetId): void;

  /**
   * Processes an update to a query target.
   *
   * Called by the primary client to notify secondary clients of document
   * changes or state transitions that affect the provided query target.
   */
  updateQueryState(
    targetId: TargetId,
    state: QueryTargetState,
    error?: FirestoreError
  ): void;

  /**
   * Removes the target's metadata entry.
   *
   * Called by the primary client when all clients stopped listening to a query
   * target.
   */
  clearQueryState(targetId: TargetId): void;

  /**
   * Gets the active Query Targets IDs for all active clients.
   *
   * The implementation for this may require O(n) runtime, where 'n' is the size
   * of the result set.
   */
  // Visible for testing
  getAllActiveQueryTargets(): SortedSet<TargetId>;

  /**
   * Checks whether the provided target ID is currently being listened to by
   * any of the active clients.
   *
   * The implementation may require O(n*log m) runtime, where 'n' is the number
   * of clients and 'm' the number of targets.
   */
  isActiveQueryTarget(targetId: TargetId): boolean;

  /**
   * Starts the SharedClientState, reads existing client data and registers
   * listeners for updates to new and existing clients.
   */
  start(): Promise<void>;

  /** Shuts down the `SharedClientState` and its listeners. */
  shutdown(): void;

  /**
   * Changes the active user and removes all existing user-specific data. The
   * user change does not call back into SyncEngine (for example, no mutations
   * will be marked as removed).
   */
  handleUserChange(
    user: User,
    removedBatchIds: BatchId[],
    addedBatchIds: BatchId[]
  ): void;

  /** Changes the shared online state of all clients. */
  setOnlineState(onlineState: OnlineState): void;

  writeSequenceNumber(sequenceNumber: ListenSequenceNumber): void;
  setSequenceNumberListener(
    cb: (sequenceNumber: ListenSequenceNumber) => void
  ): void;
}

/**
 * The JSON representation of a mutation batch's metadata as used during
 * LocalStorage serialization. The UserId and BatchId is omitted as it is
 * encoded as part of the key.
 */
interface MutationMetadataSchema {
  state: MutationBatchState;
  error?: { code: string; message: string }; // Only set when state === 'rejected'
}

/**
 * Holds the state of a mutation batch, including its user ID, batch ID and
 * whether the batch is 'pending', 'acknowledged' or 'rejected'.
 */
// Visible for testing
export class MutationMetadata {
  constructor(
    readonly user: User,
    readonly batchId: BatchId,
    readonly state: MutationBatchState,
    readonly error?: FirestoreError
  ) {
    assert(
      (error !== undefined) === (state === 'rejected'),
      `MutationMetadata must contain an error iff state is 'rejected'`
    );
  }

  /**
   * Parses a MutationMetadata from its JSON representation in LocalStorage.
   * Logs a warning and returns null if the format of the data is not valid.
   */
  static fromLocalStorageEntry(
    user: User,
    batchId: BatchId,
    value: string
  ): MutationMetadata | null {
    const mutationBatch = JSON.parse(value) as MutationMetadataSchema;

    let validData =
      typeof mutationBatch === 'object' &&
      ['pending', 'acknowledged', 'rejected'].indexOf(mutationBatch.state) !==
        -1 &&
      (mutationBatch.error === undefined ||
        typeof mutationBatch.error === 'object');

    let firestoreError = undefined;

    if (validData && mutationBatch.error) {
      validData =
        typeof mutationBatch.error.message === 'string' &&
        typeof mutationBatch.error.code === 'string';
      if (validData) {
        firestoreError = new FirestoreError(
          mutationBatch.error.code as Code,
          mutationBatch.error.message
        );
      }
    }

    if (validData) {
      return new MutationMetadata(
        user,
        batchId,
        mutationBatch.state,
        firestoreError
      );
    } else {
      error(
        LOG_TAG,
        `Failed to parse mutation state for ID '${batchId}': ${value}`
      );
      return null;
    }
  }

  toLocalStorageJSON(): string {
    const batchMetadata: MutationMetadataSchema = {
      state: this.state
    };

    if (this.error) {
      batchMetadata.error = {
        code: this.error.code,
        message: this.error.message
      };
    }

    return JSON.stringify(batchMetadata);
  }
}

/**
 * The JSON representation of a query target's state as used during LocalStorage
 * serialization. The TargetId is omitted as it is encoded as part of the key.
 */
interface QueryTargetStateSchema {
  state: QueryTargetState;
  error?: { code: string; message: string }; // Only set when state === 'rejected'
}

/**
 * Holds the state of a query target, including its target ID and whether the
 * target is 'not-current', 'current' or 'rejected'.
 */
// Visible for testing
export class QueryTargetMetadata {
  constructor(
    readonly targetId: TargetId,
    readonly state: QueryTargetState,
    readonly error?: FirestoreError
  ) {
    assert(
      (error !== undefined) === (state === 'rejected'),
      `QueryTargetMetadata must contain an error iff state is 'rejected'`
    );
  }

  /**
   * Parses a QueryTargetMetadata from its JSON representation in LocalStorage.
   * Logs a warning and returns null if the format of the data is not valid.
   */
  static fromLocalStorageEntry(
    targetId: TargetId,
    value: string
  ): QueryTargetMetadata | null {
    const targetState = JSON.parse(value) as QueryTargetStateSchema;

    let validData =
      typeof targetState === 'object' &&
      ['not-current', 'current', 'rejected'].indexOf(targetState.state) !==
        -1 &&
      (targetState.error === undefined ||
        typeof targetState.error === 'object');

    let firestoreError = undefined;

    if (validData && targetState.error) {
      validData =
        typeof targetState.error.message === 'string' &&
        typeof targetState.error.code === 'string';
      if (validData) {
        firestoreError = new FirestoreError(
          targetState.error.code as Code,
          targetState.error.message
        );
      }
    }

    if (validData) {
      return new QueryTargetMetadata(
        targetId,
        targetState.state,
        firestoreError
      );
    } else {
      error(
        LOG_TAG,
        `Failed to parse target state for ID '${targetId}': ${value}`
      );
      return null;
    }
  }

  toLocalStorageJSON(): string {
    const targetState: QueryTargetStateSchema = {
      state: this.state
    };

    if (this.error) {
      targetState.error = {
        code: this.error.code,
        message: this.error.message
      };
    }

    return JSON.stringify(targetState);
  }
}

/**
 * The JSON representation of a clients's metadata as used during LocalStorage
 * serialization. The ClientId is omitted here as it is encoded as part of the
 * key.
 */
interface ClientStateSchema {
  activeTargetIds: number[];
}

/**
 * Metadata state of a single client denoting the query targets it is actively
 * listening to.
 */
// Visible for testing.
export interface ClientState {
  readonly activeTargetIds: TargetIdSet;
}

/**
 * This class represents the immutable ClientState for a client read from
 * LocalStorage, containing the list of active query targets.
 */
class RemoteClientState implements ClientState {
  private constructor(
    readonly clientId: ClientId,
    readonly activeTargetIds: TargetIdSet
  ) {}

  /**
   * Parses a RemoteClientState from the JSON representation in LocalStorage.
   * Logs a warning and returns null if the format of the data is not valid.
   */
  static fromLocalStorageEntry(
    clientId: ClientId,
    value: string
  ): RemoteClientState | null {
    const clientState = JSON.parse(value) as ClientStateSchema;

    let validData =
      typeof clientState === 'object' &&
      clientState.activeTargetIds instanceof Array;

    let activeTargetIdsSet = targetIdSet();

    for (let i = 0; validData && i < clientState.activeTargetIds.length; ++i) {
      validData = isSafeInteger(clientState.activeTargetIds[i]);
      activeTargetIdsSet = activeTargetIdsSet.add(
        clientState.activeTargetIds[i]
      );
    }

    if (validData) {
      return new RemoteClientState(clientId, activeTargetIdsSet);
    } else {
      error(
        LOG_TAG,
        `Failed to parse client data for instance '${clientId}': ${value}`
      );
      return null;
    }
  }
}

/**
 * The JSON representation of the system's online state, as written by the
 * primary client.
 */
export interface SharedOnlineStateSchema {
  /**
   * The clientId of the client that wrote this onlineState value. Tracked so
   * that on startup, clients can check if this client is still active when
   * determining whether to apply this value or not.
   */
  readonly clientId: string;
  readonly onlineState: string;
}

/**
 * This class represents the online state for all clients participating in
 * multi-tab. The online state is only written to by the primary client, and
 * used in secondary clients to update their query views.
 */
export class SharedOnlineState {
  constructor(readonly clientId: string, readonly onlineState: OnlineState) {}

  /**
   * Parses a SharedOnlineState from its JSON representation in LocalStorage.
   * Logs a warning and returns null if the format of the data is not valid.
   */
  static fromLocalStorageEntry(value: string): SharedOnlineState | null {
    const onlineState = JSON.parse(value) as SharedOnlineStateSchema;

    const validData =
      typeof onlineState === 'object' &&
      OnlineState[onlineState.onlineState] !== undefined &&
      typeof onlineState.clientId === 'string';

    if (validData) {
      return new SharedOnlineState(
        onlineState.clientId,
        OnlineState[onlineState.onlineState]
      );
    } else {
      error(LOG_TAG, `Failed to parse online state: ${value}`);
      return null;
    }
  }
}

/**
 * Metadata state of the local client. Unlike `RemoteClientState`, this class is
 * mutable and keeps track of all pending mutations, which allows us to
 * update the range of pending mutation batch IDs as new mutations are added or
 * removed.
 *
 * The data in `LocalClientState` is not read from LocalStorage and instead
 * updated via its instance methods. The updated state can be serialized via
 * `toLocalStorageJSON()`.
 */
// Visible for testing.
export class LocalClientState implements ClientState {
  activeTargetIds = targetIdSet();

  addQueryTarget(targetId: TargetId): void {
    assert(
      !this.activeTargetIds.has(targetId),
      `Target with ID '${targetId}' already active.`
    );
    this.activeTargetIds = this.activeTargetIds.add(targetId);
  }

  removeQueryTarget(targetId: TargetId): void {
    this.activeTargetIds = this.activeTargetIds.delete(targetId);
  }

  /**
   * Converts this entry into a JSON-encoded format we can use for LocalStorage.
   * Does not encode `clientId` as it is part of the key in LocalStorage.
   */
  toLocalStorageJSON(): string {
    const data: ClientStateSchema = {
      activeTargetIds: this.activeTargetIds.toArray()
    };
    return JSON.stringify(data);
  }
}

/**
 * `WebStorageSharedClientState` uses WebStorage (window.localStorage) as the
 * backing store for the SharedClientState. It keeps track of all active
 * clients and supports modifications of the local client's data.
 */
// TODO(multitab): Rename all usages of LocalStorage to WebStorage to better differentiate from LocalClient.
export class WebStorageSharedClientState implements SharedClientState {
  syncEngine: SharedClientStateSyncer | null = null;
  onlineStateHandler: (onlineState: OnlineState) => void | null = null;

  private readonly storage: Storage;
  private readonly localClientStorageKey: string;
  private readonly activeClients: { [key: string]: ClientState } = {};
  private readonly storageListener = this.handleLocalStorageEvent.bind(this);
  private readonly clientStateKeyRe: RegExp;
  private readonly mutationBatchKeyRe: RegExp;
  private readonly queryTargetKeyRe: RegExp;
  private started = false;
  private currentUser: User;
  private sequenceNumberListener?: (
    sequenceNumber: ListenSequenceNumber
  ) => void;

  /**
   * Captures WebStorage events that occur before `start()` is called. These
   * events are replayed once `WebStorageSharedClientState` is started.
   */
  private earlyEvents: StorageEvent[] = [];

  constructor(
    private readonly queue: AsyncQueue,
    private readonly platform: Platform,
    private readonly persistenceKey: string,
    private readonly localClientId: ClientId,
    initialUser: User
  ) {
    if (!WebStorageSharedClientState.isAvailable(this.platform)) {
      throw new FirestoreError(
        Code.UNIMPLEMENTED,
        'LocalStorage is not available on this platform.'
      );
    }
    this.storage = this.platform.window.localStorage;
    this.currentUser = initialUser;
    this.localClientStorageKey = this.toLocalStorageClientStateKey(
      this.localClientId
    );
    this.activeClients[this.localClientId] = new LocalClientState();

    // Escape the special characters mentioned here:
    // https://developer.mozilla.org/en-US/docs/Web/JavaScript/Guide/Regular_Expressions
    const escapedPersistenceKey = persistenceKey.replace(
      /[.*+?^${}()|[\]\\]/g,
      '\\$&'
    );

    this.clientStateKeyRe = new RegExp(
      `^${CLIENT_STATE_KEY_PREFIX}_${escapedPersistenceKey}_([^_]*)$`
    );
    this.mutationBatchKeyRe = new RegExp(
      `^${MUTATION_BATCH_KEY_PREFIX}_${escapedPersistenceKey}_(\\d+)(?:_(.*))?$`
    );
    this.queryTargetKeyRe = new RegExp(
      `^${QUERY_TARGET_KEY_PREFIX}_${escapedPersistenceKey}_(\\d+)$`
    );

    // Rather than adding the storage observer during start(), we add the
    // storage observer during initialization. This ensures that we collect
    // events before other components populate their initial state (during their
    // respective start() calls). Otherwise, we might for example miss a
    // mutation that is added after LocalStore's start() processed the existing
    // mutations but before we observe WebStorage events.
    this.platform.window.addEventListener('storage', this.storageListener);
  }

  /** Returns 'true' if LocalStorage is available in the current environment. */
  static isAvailable(platform: Platform): boolean {
    return platform.window && platform.window.localStorage != null;
  }

  // TOOD(multitab): Register the mutations that are already pending at client
  // startup.
  async start(): Promise<void> {
    assert(!this.started, 'WebStorageSharedClientState already started');
    assert(
      this.syncEngine !== null,
      'syncEngine property must be set before calling start()'
    );
    assert(
      this.onlineStateHandler !== null,
      'onlineStateHandler property must be set before calling start()'
    );

    // Retrieve the list of existing clients to backfill the data in
    // SharedClientState.
    const existingClients = await this.syncEngine.getActiveClients();

    for (const clientId of existingClients) {
      if (clientId === this.localClientId) {
        continue;
      }

      const storageItem = this.getItem(
        this.toLocalStorageClientStateKey(clientId)
      );
      if (storageItem) {
        const clientState = RemoteClientState.fromLocalStorageEntry(
          clientId,
          storageItem
        );
        if (clientState) {
          this.activeClients[clientState.clientId] = clientState;
        }
      }
    }

    this.persistClientState();

    // Check if there is an existing online state and call the callback handler
    // if applicable.
    const onlineStateJSON = this.storage.getItem(ONLINE_STATE_KEY);
    if (onlineStateJSON) {
      const onlineState = this.fromLocalStorageOnlineState(onlineStateJSON);
      if (onlineState) {
        this.handleOnlineStateEvent(onlineState);
      }
    }

    for (const event of this.earlyEvents) {
      this.handleLocalStorageEvent(event);
    }

    this.earlyEvents = [];

    // Register a window unload hook to remove the client metadata entry from
    // LocalStorage even if `shutdown()` was not called.
    this.platform.window.addEventListener('unload', () => this.shutdown());

    this.started = true;
  }

  setSequenceNumberListener(
    cb: (sequenceNumber: ListenSequenceNumber) => void
  ): void {
    this.sequenceNumberListener = cb;
  }

  writeSequenceNumber(sequenceNumber: ListenSequenceNumber): void {
    this.setItem(SEQUENCE_NUMBER_KEY, JSON.stringify(sequenceNumber));
  }

  getAllActiveQueryTargets(): TargetIdSet {
    let activeTargets = targetIdSet();
    objUtils.forEach(this.activeClients, (key, value) => {
      activeTargets = activeTargets.unionWith(value.activeTargetIds);
    });
    return activeTargets;
  }

  isActiveQueryTarget(targetId: TargetId): boolean {
    // This is not using `obj.forEach` since `forEach` doesn't support early
    // return.
    for (const clientId in this.activeClients) {
      if (this.activeClients.hasOwnProperty(clientId)) {
        if (this.activeClients[clientId].activeTargetIds.has(targetId)) {
          return true;
        }
      }
    }
    return false;
  }

  addPendingMutation(batchId: BatchId): void {
    this.persistMutationState(batchId, 'pending');
  }

  updateMutationState(
    batchId: BatchId,
    state: 'acknowledged' | 'rejected',
    error?: FirestoreError
  ): void {
    this.persistMutationState(batchId, state, error);

    // Once a final mutation result is observed by other clients, they no longer
    // access the mutation's metadata entry. Since LocalStorage replays events
    // in order, it is safe to delete the entry right after updating it.
    this.removeMutationState(batchId);
  }

  addLocalQueryTarget(targetId: TargetId): QueryTargetState {
    let queryState: QueryTargetState = 'not-current';

    // Lookup an existing query state if the target ID was already registered
    // by another tab
    if (this.isActiveQueryTarget(targetId)) {
      const storageItem = this.storage.getItem(
        this.toLocalStorageQueryTargetMetadataKey(targetId)
      );

      if (storageItem) {
        const metadata = QueryTargetMetadata.fromLocalStorageEntry(
          targetId,
          storageItem
        );
        if (metadata) {
          queryState = metadata.state;
        }
      }
    }

    this.localClientState.addQueryTarget(targetId);
    this.persistClientState();

    return queryState;
  }

  removeLocalQueryTarget(targetId: TargetId): void {
    this.localClientState.removeQueryTarget(targetId);
    this.persistClientState();
  }

  clearQueryState(targetId: TargetId): void {
    this.removeItem(this.toLocalStorageQueryTargetMetadataKey(targetId));
  }

  updateQueryState(
    targetId: TargetId,
    state: QueryTargetState,
    error?: FirestoreError
  ): void {
    this.persistQueryTargetState(targetId, state, error);
  }

  handleUserChange(
    user: User,
    removedBatchIds: BatchId[],
    addedBatchIds: BatchId[]
  ): void {
    removedBatchIds.forEach(batchId => {
      this.removeMutationState(batchId);
    });
    this.currentUser = user;
    addedBatchIds.forEach(batchId => {
      this.addPendingMutation(batchId);
    });
  }

  setOnlineState(onlineState: OnlineState): void {
    this.persistOnlineState(onlineState);
  }

  shutdown(): void {
    if (this.started) {
      this.platform.window.removeEventListener('storage', this.storageListener);
      this.removeItem(this.localClientStorageKey);
      this.started = false;
    }
  }

  private getItem(key: string): string | null {
    const value = this.storage.getItem(key);
    debug(LOG_TAG, 'READ', key, value);
    return value;
  }

  private setItem(key: string, value: string): void {
    debug(LOG_TAG, 'SET', key, value);
    this.storage.setItem(key, value);
  }

  private removeItem(key: string): void {
    debug(LOG_TAG, 'REMOVE', key);
    this.storage.removeItem(key);
  }

  private handleLocalStorageEvent(event: StorageEvent): void {
    if (event.storageArea === this.storage) {
      // TODO(multitab): This assert will likely become invalid as we add garbage
      // collection.
      assert(
        event.key !== this.localClientStorageKey,
        'Received LocalStorage notification for local change.'
      );

      debug(LOG_TAG, 'EVENT', event.key, event.newValue);

      this.queue.enqueueAndForget(async () => {
        if (!this.started) {
          this.earlyEvents.push(event);
          return;
        }

        if (this.clientStateKeyRe.test(event.key)) {
          if (event.newValue != null) {
            const clientState = this.fromLocalStorageClientState(
              event.key,
              event.newValue
            );
            if (clientState) {
              return this.handleClientStateEvent(
                clientState.clientId,
                clientState
              );
            }
          } else {
            const clientId = this.fromLocalStorageClientStateKey(event.key);
            return this.handleClientStateEvent(clientId, null);
          }
        } else if (this.mutationBatchKeyRe.test(event.key)) {
          if (event.newValue !== null) {
            const mutationMetadata = this.fromLocalStorageMutationMetadata(
              event.key,
              event.newValue
            );
            if (mutationMetadata) {
              return this.handleMutationBatchEvent(mutationMetadata);
            }
          }
        } else if (this.queryTargetKeyRe.test(event.key)) {
          if (event.newValue !== null) {
            const queryTargetMetadata = this.fromLocalStorageQueryTargetMetadata(
              event.key,
              event.newValue
            );
            if (queryTargetMetadata) {
              return this.handleQueryTargetEvent(queryTargetMetadata);
            }
          }
        } else if (event.key === ONLINE_STATE_KEY) {
          if (event.newValue !== null) {
            const onlineState = this.fromLocalStorageOnlineState(
              event.newValue
            );
            if (onlineState) {
              return this.handleOnlineStateEvent(onlineState);
            }
          }
        } else if (event.key === SEQUENCE_NUMBER_KEY) {
          if (this.sequenceNumberListener) {
            const sequenceNumber = parseSequenceNumber(event.newValue);
            if (sequenceNumber !== ListenSequence.INVALID) {
              this.sequenceNumberListener(sequenceNumber);
            }
          }
        }
      });
    }
  }

  private get localClientState(): LocalClientState {
    return this.activeClients[this.localClientId] as LocalClientState;
  }

  private persistClientState(): void {
    this.setItem(
      this.localClientStorageKey,
      this.localClientState.toLocalStorageJSON()
    );
  }

  private persistMutationState(
    batchId: BatchId,
    state: MutationBatchState,
    error?: FirestoreError
  ): void {
    const mutationState = new MutationMetadata(
      this.currentUser,
      batchId,
      state,
      error
    );
    const mutationKey = this.toLocalStorageMutationBatchKey(batchId);
    this.setItem(mutationKey, mutationState.toLocalStorageJSON());
  }

  private removeMutationState(batchId: BatchId): void {
    const mutationKey = this.toLocalStorageMutationBatchKey(batchId);
    this.removeItem(mutationKey);
  }

  private persistOnlineState(onlineState: OnlineState): void {
    const entry: SharedOnlineStateSchema = {
      clientId: this.localClientId,
      onlineState: OnlineState[onlineState]
    };
    this.storage.setItem(ONLINE_STATE_KEY, JSON.stringify(entry));
  }

  private persistQueryTargetState(
    targetId: TargetId,
    state: QueryTargetState,
    error?: FirestoreError
  ): void {
    const targetKey = this.toLocalStorageQueryTargetMetadataKey(targetId);
    const targetMetadata = new QueryTargetMetadata(targetId, state, error);
    this.setItem(targetKey, targetMetadata.toLocalStorageJSON());
  }

  /** Assembles the key for a client state in LocalStorage */
  private toLocalStorageClientStateKey(clientId: ClientId): string {
    assert(
      clientId.indexOf('_') === -1,
      `Client key cannot contain '_', but was '${clientId}'`
    );

    return `${CLIENT_STATE_KEY_PREFIX}_${this.persistenceKey}_${clientId}`;
  }

  /** Assembles the key for a query state in LocalStorage */
  private toLocalStorageQueryTargetMetadataKey(targetId: TargetId): string {
    return `${QUERY_TARGET_KEY_PREFIX}_${this.persistenceKey}_${targetId}`;
  }

  /** Assembles the key for a mutation batch in LocalStorage */
  private toLocalStorageMutationBatchKey(batchId: BatchId): string {
    let mutationKey = `${MUTATION_BATCH_KEY_PREFIX}_${
      this.persistenceKey
    }_${batchId}`;

    if (this.currentUser.isAuthenticated()) {
      mutationKey += `_${this.currentUser.uid}`;
    }

    return mutationKey;
  }

  /**
   * Parses a client state key in LocalStorage. Returns null if the key does not
   * match the expected key format.
   */
  private fromLocalStorageClientStateKey(key: string): ClientId | null {
    const match = this.clientStateKeyRe.exec(key);
    return match ? match[1] : null;
  }

  /**
   * Parses a client state in LocalStorage. Returns 'null' if the value could
   * not be parsed.
   */
  private fromLocalStorageClientState(
    key: string,
    value: string
  ): RemoteClientState | null {
    const clientId = this.fromLocalStorageClientStateKey(key);
    assert(clientId !== null, `Cannot parse client state key '${key}'`);
    return RemoteClientState.fromLocalStorageEntry(clientId, value);
  }

  /**
   * Parses a mutation batch state in LocalStorage. Returns 'null' if the value
   * could not be parsed.
   */
  private fromLocalStorageMutationMetadata(
    key: string,
    value: string
  ): MutationMetadata | null {
    const match = this.mutationBatchKeyRe.exec(key);
    assert(match !== null, `Cannot parse mutation batch key '${key}'`);

    const batchId = Number(match[1]);
    const userId = match[2] !== undefined ? match[2] : null;
    return MutationMetadata.fromLocalStorageEntry(
      new User(userId),
      batchId,
      value
    );
  }

  /**
   * Parses a query target state from LocalStorage. Returns 'null' if the value
   * could not be parsed.
   */
  private fromLocalStorageQueryTargetMetadata(
    key: string,
    value: string
  ): QueryTargetMetadata | null {
    const match = this.queryTargetKeyRe.exec(key);
    assert(match !== null, `Cannot parse query target key '${key}'`);

    const targetId = Number(match[1]);
    return QueryTargetMetadata.fromLocalStorageEntry(targetId, value);
  }

  /**
   * Parses an online state from LocalStorage. Returns 'null' if the value
   * could not be parsed.
   */
  private fromLocalStorageOnlineState(value: string): SharedOnlineState | null {
    return SharedOnlineState.fromLocalStorageEntry(value);
  }

  private async handleMutationBatchEvent(
    mutationBatch: MutationMetadata
  ): Promise<void> {
    if (mutationBatch.user.uid !== this.currentUser.uid) {
      debug(
        LOG_TAG,
        `Ignoring mutation for non-active user ${mutationBatch.user.uid}`
      );
      return;
    }

    return this.syncEngine.applyBatchState(
      mutationBatch.batchId,
      mutationBatch.state,
      mutationBatch.error
    );
  }

  private handleQueryTargetEvent(
    targetMetadata: QueryTargetMetadata
  ): Promise<void> {
    return this.syncEngine.applyTargetState(
      targetMetadata.targetId,
      targetMetadata.state,
      targetMetadata.error
    );
  }

  private handleClientStateEvent(
    clientId: ClientId,
    clientState: RemoteClientState | null
  ): Promise<void> {
    const existingTargets = this.getAllActiveQueryTargets();

    if (clientState) {
      this.activeClients[clientId] = clientState;
    } else {
      delete this.activeClients[clientId];
    }

    const newTargets = this.getAllActiveQueryTargets();

    const addedTargets: TargetId[] = [];
    const removedTargets: TargetId[] = [];

    newTargets.forEach(async targetId => {
      if (!existingTargets.has(targetId)) {
        addedTargets.push(targetId);
      }
    });

    existingTargets.forEach(async targetId => {
      if (!newTargets.has(targetId)) {
        removedTargets.push(targetId);
      }
    });

    return this.syncEngine.applyActiveTargetsChange(
      addedTargets,
      removedTargets
    );
  }

  private handleOnlineStateEvent(onlineState: SharedOnlineState): void {
    // We check whether the client that wrote this online state is still active
    // by comparing its client ID to the list of clients kept active in
    // IndexedDb. If a client does not update their IndexedDb client state
    // within 5 seconds, it is considered inactive and we don't emit an online
    // state event.
    if (this.activeClients[onlineState.clientId]) {
      this.onlineStateHandler(onlineState.onlineState);
    }
  }
}

//
function parseSequenceNumber(seqString: string | null): ListenSequenceNumber {
  let sequenceNumber = ListenSequence.INVALID;
  if (seqString != null) {
    try {
      const parsed = JSON.parse(seqString) as ListenSequenceNumber;
      assert(typeof parsed === 'number', 'Found non-numeric sequence number');
      sequenceNumber = parsed;
    } catch (e) {
      error(LOG_TAG, 'Failed to read sequence number from local storage', e);
    }
  }
  return sequenceNumber;
}

/**
 * `MemorySharedClientState` is a simple implementation of SharedClientState for
 * clients using memory persistence. The state in this class remains fully
 * isolated and no synchronization is performed.
 */
export class MemorySharedClientState implements SharedClientState {
  private localState = new LocalClientState();
  private queryState: { [targetId: number]: QueryTargetState } = {};

  syncEngine: SharedClientStateSyncer | null = null;
  onlineStateHandler: (onlineState: OnlineState) => void | null = null;

  addPendingMutation(batchId: BatchId): void {
    // No op.
  }

  updateMutationState(
    batchId: BatchId,
    state: 'acknowledged' | 'rejected',
    error?: FirestoreError
  ): void {
    // No op.
  }

  addLocalQueryTarget(targetId: TargetId): QueryTargetState {
    this.localState.addQueryTarget(targetId);
    return this.queryState[targetId] || 'not-current';
  }

  updateQueryState(
    targetId: TargetId,
    state: QueryTargetState,
    error?: FirestoreError
  ): void {
    this.queryState[targetId] = state;
  }

  removeLocalQueryTarget(targetId: TargetId): void {
    this.localState.removeQueryTarget(targetId);
  }

  clearQueryState(targetId: TargetId): void {
    delete this.queryState[targetId];
  }

  getAllActiveQueryTargets(): TargetIdSet {
    return this.localState.activeTargetIds;
  }

  isActiveQueryTarget(targetId: TargetId): boolean {
    return this.localState.activeTargetIds.has(targetId);
  }

  start(): Promise<void> {
    this.localState = new LocalClientState();
    return Promise.resolve();
  }

  handleUserChange(
    user: User,
    removedBatchIds: BatchId[],
    addedBatchIds: BatchId[]
  ): void {
    // No op.
  }

  setOnlineState(onlineState: OnlineState): void {
    // No op.
  }

  shutdown(): void {}

  writeSequenceNumber(sequenceNumber: ListenSequenceNumber): void {}
  setSequenceNumberListener(
    cb: (sequenceNumber: ListenSequenceNumber) => void
  ): void {}
}
