'use strict';

var Backbone = require('backbone'),
    GroupCollection = require('../collections/group-collection'),
    GroupModel = require('./group-model'),
    IconUrl = require('../util/icon-url'),
    Logger = require('../util/logger'),
    kdbxweb = require('kdbxweb'),
    demoFileData = require('base64!../../resources/Demo.kdbx');

var logger = new Logger('file');

var FileModel = Backbone.Model.extend({
    defaults: {
        id: '',
        uuid: '',
        name: '',
        keyFileName: '',
        passwordLength: 0,
        path: '',
        opts: null,
        storage: null,
        modified: false,
        dirty: false,
        open: false,
        created: false,
        demo: false,
        groups: null,
        oldPasswordLength: 0,
        oldKeyFileName: '',
        passwordChanged: false,
        keyFileChanged: false,
        keyChangeForce: -1,
        syncing: false,
        syncError: null,
        syncDate: null
    },

    db: null,
    entryMap: null,
    groupMap: null,

    initialize: function() {
        this.entryMap = {};
        this.groupMap = {};
    },

    open: function(password, fileData, keyFileData, callback) {
        try {
            var credentials = new kdbxweb.Credentials(password, keyFileData);
            var ts = logger.ts();
            kdbxweb.Kdbx.load(fileData, credentials, (function(db, err) {
                if (err) {
                    if (err.code === kdbxweb.Consts.ErrorCodes.InvalidKey && password && !password.byteLength) {
                        logger.info('Error opening file with empty password, try to open with null password');
                        return this.open(null, fileData, keyFileData, callback);
                    }
                    logger.error('Error opening file', err.code, err.message, err);
                    callback(err);
                } else {
                    this.db = db;
                    this.readModel();
                    this.setOpenFile({ passwordLength: password ? password.textLength : 0 });
                    if (keyFileData) {
                        kdbxweb.ByteUtils.zeroBuffer(keyFileData);
                    }
                    logger.info('Opened file ' + this.get('name') + ': ' + logger.ts(ts) + ', ' +
                        db.header.keyEncryptionRounds + ' rounds, ' + Math.round(fileData.byteLength / 1024) + ' kB');
                    callback();
                }
            }).bind(this));
        } catch (e) {
            logger.error('Error opening file', e, e.code, e.message, e);
            callback(e);
        }
    },

    create: function(name) {
        var password = kdbxweb.ProtectedValue.fromString('');
        var credentials = new kdbxweb.Credentials(password);
        this.db = kdbxweb.Kdbx.create(credentials, name);
        this.set('name', name);
        this.readModel();
        this.set({ open: true, created: true, name: name });
    },

    importWithXml: function(fileXml, callback) {
        try {
            var ts = logger.ts();
            var password = kdbxweb.ProtectedValue.fromString('');
            var credentials = new kdbxweb.Credentials(password);
            kdbxweb.Kdbx.loadXml(fileXml, credentials, (function(db, err) {
                if (err) {
                    logger.error('Error importing file', err.code, err.message, err);
                    callback(err);
                } else {
                    this.db = db;
                    this.readModel();
                    this.set({ open: true, created: true });
                    logger.info('Imported file ' + this.get('name') + ': ' + logger.ts(ts));
                    callback();
                }
            }).bind(this));
        } catch (e) {
            logger.error('Error importing file', e, e.code, e.message, e);
            callback(e);
        }
    },

    openDemo: function(callback) {
        var password = kdbxweb.ProtectedValue.fromString('demo');
        var credentials = new kdbxweb.Credentials(password);
        var demoFile = kdbxweb.ByteUtils.arrayToBuffer(kdbxweb.ByteUtils.base64ToBytes(demoFileData));
        kdbxweb.Kdbx.load(demoFile, credentials, (function(db) {
            this.db = db;
            this.set('name', 'Demo');
            this.readModel();
            this.setOpenFile({passwordLength: 4, demo: true});
            callback();
        }).bind(this));
    },

    setOpenFile: function(props) {
        _.extend(props, {
            open: true,
            oldKeyFileName: this.get('keyFileName'),
            oldPasswordLength: props.passwordLength,
            passwordChanged: false,
            keyFileChanged: false
        });
        this.set(props);
        this._oldPasswordHash = this.db.credentials.passwordHash;
        this._oldKeyFileHash = this.db.credentials.keyFileHash;
        this._oldKeyChangeDate = this.db.meta.keyChanged;
    },

    readModel: function() {
        var groups = new GroupCollection();
        this.set({
            uuid: this.db.getDefaultGroup().uuid.toString(),
            groups: groups,
            defaultUser: this.db.meta.defaultUser,
            recycleBinEnabled: this.db.meta.recycleBinEnabled,
            historyMaxItems: this.db.meta.historyMaxItems,
            historyMaxSize: this.db.meta.historyMaxSize,
            keyEncryptionRounds: this.db.header.keyEncryptionRounds,
            keyChangeForce: this.db.meta.keyChangeForce
        }, { silent: true });
        this.db.groups.forEach(function(group) {
            var groupModel = this.getGroup(this.subId(group.uuid.id));
            if (groupModel) {
                groupModel.setGroup(group, this);
            } else {
                groupModel = GroupModel.fromGroup(group, this);
            }
            groups.add(groupModel);
        }, this);
        this.buildObjectMap();
    },

    subId: function(id) {
        return this.id + ':' + id;
    },

    buildObjectMap: function() {
        var entryMap = {};
        var groupMap = {};
        this.forEachGroup(function(group) {
            groupMap[group.id] = group;
            group.forEachOwnEntry(null, function(entry) {
                entryMap[entry.id] = entry;
            });
        }, true);
        this.entryMap = entryMap;
        this.groupMap = groupMap;
    },

    reload: function() {
        this.buildObjectMap();
        this.readModel();
        this.trigger('reload', this);
    },

    mergeOrUpdate: function(fileData, remoteKey, callback) {
        var credentials;
        if (remoteKey) {
            credentials = new kdbxweb.Credentials(kdbxweb.ProtectedValue.fromString(''));
            if (remoteKey.password) {
                credentials.setPassword(remoteKey.password);
            } else {
                credentials.passwordHash = this.db.credentials.passwordHash;
            }
            if (remoteKey.keyFileName) {
                if (remoteKey.keyFileData) {
                    credentials.setKeyFile(remoteKey.keyFileData);
                } else {
                    credentials.keyFileHash = this.db.credentials.keyFileHash;
                }
            }
        } else {
            credentials = this.db.credentials;
        }
        kdbxweb.Kdbx.load(fileData, credentials, (function(remoteDb, err) {
            if (err) {
                logger.error('Error opening file to merge', err.code, err.message, err);
            } else {
                if (this.get('modified')) {
                    try {
                        if (remoteKey && remoteDb.meta.keyChanged > this.db.meta.keyChanged) {
                            this.db.credentials = remoteDb.credentials;
                            this.set('keyFileName', remoteKey.keyFileName || '');
                            if (remoteKey.password) {
                                this.set('passwordLength', remoteKey.password.textLength);
                            }
                        }
                        this.db.merge(remoteDb);
                    } catch (e) {
                        logger.error('File merge error', e);
                        return callback(e);
                    }
                } else {
                    this.db = remoteDb;
                }
                this.set('dirty', true);
                this.reload();
            }
            callback(err);
        }).bind(this));
    },

    getLocalEditState: function() {
        return this.db.getLocalEditState();
    },

    setLocalEditState: function(editState) {
        this.db.setLocalEditState(editState);
    },

    close: function() {
        this.set({
            keyFileName: '',
            passwordLength: 0,
            modified: false,
            dirty: false,
            open: false,
            created: false,
            groups: null,
            passwordChanged: false,
            keyFileChanged: false,
            syncing: false
        });
    },

    getEntry: function(id) {
        return this.entryMap[id];
    },

    getGroup: function(id) {
        return this.groupMap[id];
    },

    forEachEntry: function(filter, callback) {
        var top = this;
        if (filter.trash) {
            top = this.getGroup(this.db.meta.recycleBinUuid ? this.subId(this.db.meta.recycleBinUuid.id) : null);
        } else if (filter.group) {
            top = this.getGroup(filter.group);
        }
        if (top) {
            if (top.forEachOwnEntry) {
                top.forEachOwnEntry(filter, callback);
            }
            if (!filter.group || filter.subGroups) {
                top.forEachGroup(function (group) {
                    group.forEachOwnEntry(filter, callback);
                });
            }
        }
    },

    forEachGroup: function(callback, includeDisabled) {
        this.get('groups').forEach(function(group) {
            if (callback(group) !== false) {
                group.forEachGroup(callback, includeDisabled);
            }
        });
    },

    getTrashGroup: function() {
        return this.db.meta.recycleBinEnabled ? this.getGroup(this.subId(this.db.meta.recycleBinUuid.id)) : null;
    },

    setModified: function() {
        if (!this.get('demo')) {
            this.set({ modified: true, dirty: true });
        }
    },

    getData: function(cb) {
        this.db.cleanup({
            historyRules: true,
            customIcons: true,
            binaries: true
        });
        var that = this;
        this.db.cleanup({ binaries: true });
        this.db.save(function(data, err) {
            if (err) {
                logger.error('Error saving file', that.get('name'), err);
            }
            cb(data, err);
        });
    },

    getXml: function(cb) {
        this.db.saveXml(cb);
    },

    getKeyFileHash: function() {
        var hash = this.db.credentials.keyFileHash;
        return hash ? kdbxweb.ByteUtils.bytesToBase64(hash.getBinary()) : null;
    },

    setSyncProgress: function() {
        this.set({ syncing: true });
    },

    setSyncComplete: function(path, storage, error, savedToCache) {
        if (!error) {
            this.db.removeLocalEditState();
        }
        var modified = this.get('modified') && !!error;
        var dirty = this.get('dirty') && !savedToCache;
        this.set({
            created: false,
            path: path || this.get('path'),
            storage: storage || this.get('storage'),
            modified: modified,
            dirty: dirty,
            syncing: false,
            syncError: error
        });
        if (!this.get('open')) {
            return;
        }
        this.setOpenFile({ passwordLength: this.get('passwordLength') });
        this.forEachEntry({}, function(entry) {
            entry.setSaved();
        });
    },

    setPassword: function(password) {
        this.db.credentials.setPassword(password);
        this.db.meta.keyChanged = new Date();
        this.set({ passwordLength: password.textLength, passwordChanged: true });
        this.setModified();
    },

    resetPassword: function() {
        this.db.credentials.passwordHash = this._oldPasswordHash;
        if (this.db.credentials.keyFileHash === this._oldKeyFileHash) {
            this.db.meta.keyChanged = this._oldKeyChangeDate;
        }
        this.set({ passwordLength: this.get('oldPasswordLength'), passwordChanged: false });
    },

    setKeyFile: function(keyFile, keyFileName) {
        this.db.credentials.setKeyFile(keyFile);
        this.db.meta.keyChanged = new Date();
        this.set({ keyFileName: keyFileName, keyFileChanged: true });
        this.setModified();
    },

    generateAndSetKeyFile: function() {
        var keyFile = kdbxweb.Credentials.createRandomKeyFile();
        var keyFileName = 'Generated';
        this.setKeyFile(keyFile, keyFileName);
        return keyFile;
    },

    resetKeyFile: function() {
        this.db.credentials.keyFileHash = this._oldKeyFileHash;
        if (this.db.credentials.passwordHash === this._oldPasswordHash) {
            this.db.meta.keyChanged = this._oldKeyChangeDate;
        }
        this.set({ keyFileName: this.get('oldKeyFileName'), keyFileChanged: false });
    },

    removeKeyFile: function() {
        this.db.credentials.keyFileHash = null;
        var changed = !!this._oldKeyFileHash;
        if (!changed && this.db.credentials.passwordHash === this._oldPasswordHash) {
            this.db.meta.keyChanged = this._oldKeyChangeDate;
        }
        this.set({ keyFileName: '', keyFileChanged: changed });
        this.setModified();
    },

    isKeyChangePending: function(force) {
        if (!this.db.meta.keyChanged) {
            return false;
        }
        var expiryDays = force ? this.db.meta.keyChangeForce : this.db.meta.keyChangeRec;
        if (!expiryDays || expiryDays < 0 || isNaN(expiryDays)) {
            return false;
        }
        var daysDiff = (Date.now() - this.db.meta.keyChanged) / 1000 / 3600 / 24;
        return daysDiff > expiryDays;
    },

    setKeyChange: function(force, days) {
        if (isNaN(days) || !days || days < 0) {
            days = -1;
        }
        var prop = force ? 'keyChangeForce' : 'keyChangeRec';
        this.db.meta[prop] = days;
        this.set(prop, days);
        this.setModified();
    },

    setName: function(name) {
        this.db.meta.name = name;
        this.db.meta.nameChanged = new Date();
        this.set('name', name);
        this.get('groups').first().setName(name);
        this.setModified();
        this.reload();
    },

    setDefaultUser: function(defaultUser) {
        this.db.meta.defaultUser = defaultUser;
        this.db.meta.defaultUserChanged = new Date();
        this.set('defaultUser', defaultUser);
        this.setModified();
    },

    setRecycleBinEnabled: function(enabled) {
        enabled = !!enabled;
        this.db.meta.recycleBinEnabled = enabled;
        if (enabled) {
            this.db.createRecycleBin();
        }
        this.set('setRecycleBinEnabled', enabled);
        this.setModified();
    },

    setHistoryMaxItems: function(count) {
        this.db.meta.historyMaxItems = count;
        this.set('historyMaxItems', count);
        this.setModified();
    },

    setHistoryMaxSize: function(size) {
        this.db.meta.historyMaxSize = size;
        this.set('historyMaxSize', size);
        this.setModified();
    },

    setKeyEncryptionRounds: function(rounds) {
        this.db.header.keyEncryptionRounds = rounds;
        this.set('keyEncryptionRounds', rounds);
        this.setModified();
    },

    emptyTrash: function() {
        var trashGroup = this.getTrashGroup();
        if (trashGroup) {
            trashGroup.getOwnSubGroups().slice().forEach(function(group) {
                this.db.move(group, null);
            }, this);
            trashGroup.group.entries.forEach(function(entry) {
                this.db.move(entry, null);
            }, this);
            trashGroup.get('entries').reset();
        }
    },

    getCustomIcons: function() {
        return _.mapObject(this.db.meta.customIcons, function(customIcon) {
            return IconUrl.toDataUrl(customIcon);
        });
    },

    addCustomIcon: function(iconData) {
        var uuid = kdbxweb.KdbxUuid.random();
        this.db.meta.customIcons[uuid] = kdbxweb.ByteUtils.arrayToBuffer(kdbxweb.ByteUtils.base64ToBytes(iconData));
        return uuid.toString();
    },

    renameTag: function(from, to) {
        this.forEachEntry({}, function(entry) {
            entry.renameTag(from, to);
        });
    }
});

FileModel.createKeyFileWithHash = function(hash) {
    return kdbxweb.Credentials.createKeyFileWithHash(hash);
};

module.exports = FileModel;
