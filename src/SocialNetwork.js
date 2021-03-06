import SignedMessage from './SignedMessage';
import Key from './Key';
import Contact from './Contact';
import Attribute from './Attribute';
import Channel from './Channel';
import Collection from './collection';
import util from './util';
import Gun from 'gun'; // eslint-disable-line no-unused-vars
// eslint-disable-line no-unused-vars
import then from 'gun/lib/then'; // eslint-disable-line no-unused-vars
import load from 'gun/lib/load'; // eslint-disable-line no-unused-vars

if (Gun && Gun.User) {
  Gun.User.prototype.top = function(key) {
    const gun = this, root = gun.back(-1), user = root.user();
    if (!user.is) { throw {err: 'Not logged in!'}; }
    const top = user.chain(), at = (top._);
    at.soul = at.get = `~${user.is.pub  }.${  key}`;
    const tmp = (root.get(at.soul)._);
    (tmp.echo || (tmp.echo = {}))[at.id] = at;
    return top;
  };
}

// temp method for GUN search
async function searchText(node, callback, query, limit) { // , cursor, desc
  const seen = {};
  node.map().once((value, key) => {
    //console.log(`searchText`, value, key, desc);
    if (key.indexOf(query) === 0) {
      if (typeof limit === `number` && Object.keys(seen).length >= limit) {
        return;
      }
      if (Object.prototype.hasOwnProperty.call(seen, key)) {
        return;
      }
      if (value && Object.keys(value).length > 1) {
        seen[key] = true;
        callback({value, key});
      }
    }
  });
}

// TODO: flush onto IPFS
/**
* **Experimental.** Unlike Channel, this is probably not the most useful class yet.
*
* The essence of Iris: A database of Contacts and SignedMessages within your web of trust.
*
* NOTE: these docs reflect the latest commit at https://github.com/irislib/iris-lib
*
* To use someone else's index (read-only): set options.pubKey
*
* To use your own index: set options.keypair or omit it to use Key.getDefaultKey().
*
* Each added SignedMessage updates the SignedMessage and Contacts indexes and web of trust accordingly.
*
* You can pass options.gun to use custom gun storages and networking settings.
*
* If you want messages saved to IPFS, pass options.ipfs = instance.
*
* Wait for index.ready promise to resolve before calling instance methods.
* @param {Object} options see default options in example
* @example
* https://github.com/irislib/iris-lib/blob/master/__tests__/SocialNetwork.js
*
* Default options:
*{
*  ipfs: undefined,
*  keypair: undefined,
*  pubKey: undefined,
*  gun: undefined,
*  self: undefined,
*  indexSync: {
*    importOnAdd: {
*      enabled: true,
*      maxMsgCount: 500,
*      maxMsgDistance: 2
*    },
*    subscribe: {
*      enabled: true,
*      maxMsgDistance: 1
*    },
*    query: {
*      enabled: true
*    },
*    msgTypes: {
*      all: false,
*      rating: true,
*      verification: true,
*      unverification: true
*    },
*    debug: false
*  }
*}
* @returns {SocialNetwork}  index object
*/
class SocialNetwork {
  constructor(options) {
    this.options = Object.assign({
      ipfs: undefined,
      keypair: undefined,
      pubKey: undefined,
      self: undefined,
      indexSync: {
        importOnAdd: {
          enabled: true,
          maxMsgCount: 100,
          maxMsgDistance: 2
        },
        subscribe: {
          enabled: true,
          maxMsgDistance: 1
        },
        query: {
          enabled: true
        },
        msgTypes: {
          all: false,
          rating: true,
          verification: true,
          unverification: true
        },
        debug: false
      }
    }, options);

    if (options.pubKey) { // someone else's index
      const gun = options.gun || new Gun();
      const user = gun.user(options.pubKey);
      this.gun = user.get(`iris`);
      this.rootContact = new Attribute({type: `keyID`, value: options.pubKey});
      this.ready = Promise.resolve();
    } else { // our own index
      this.ready = this._init();
    }
    this.ready.then(() => this._subscribeToTrustedIndexes());
  }

  async _init() {
    let keypair = this.options.keypair;
    if (!keypair) {
      keypair = await Key.getDefault();
    }
    const gun = this.options.gun || new Gun();
    const user = gun.user();
    user.auth(keypair);
    this.writable = true;
    this.rootContact = new Attribute(`keyID`, Key.getId(keypair));
    user.get(`epub`).put(keypair.epub);
    // Initialize indexes with deterministic gun souls (.top)
    this.gun = user.get(`iris`).put(user.top(`iris`));
    this.gun.get(`identitiesBySearchKey`).put(user.top(`identitiesBySearchKey`));
    this.gun.get(`identitiesByTrustDistance`).put(user.top(`identitiesByTrustDistance`));
    this.gun.get(`messages`).put(user.top(`messages`));
    this.gun.get(`messagesByTimestamp`).put(user.top(`messagesByTimestamp`));
    this.gun.get(`messagesByHash`).put(user.top(`messagesByHash`));
    this.gun.get(`messagesByDistance`).put(user.top(`messagesByDistance`));

    this.messages = new Collection({gun: this.gun, class: SignedMessage, indexes: [`time`, `trustDistance`]});
    this.contacts = new Collection({gun: this.gun, class: Contact});

    const uri = this.rootContact.uri();
    const g = user.top(uri);
    this.gun.get(`identitiesBySearchKey`).get(uri).put(g);
    const attrs = {};
    attrs[uri] = this.rootContact;
    if (this.options.self) {
      const keys = Object.keys(this.options.self);
      for (let i = 0;i < keys.length;i++) {
        const a = new Attribute(keys[i], this.options.self[keys[i]]);
        attrs[a.uri()] = a;
      }
    }
    const id = Contact.create(g, {trustDistance: 0, linkTo: this.rootContact, attrs}, this);
    await this._addContactToIndexes(id.gun);
    if (this.options.self) {
      const recipient = Object.assign(this.options.self, {keyID: this.rootContact.value});
      SignedMessage.createVerification({recipient}, keypair).then(msg => {
        this.addMessage(msg);
      });
    }
  }

  _subscribeToTrustedIndexes() {
    if (this.writable && this.options.indexSync.subscribe.enabled) {
      setTimeout(() => {
        this.gun.get(`trustedIndexes`).map().once((val, uri) => {
          if (val) {
            // TODO: only get new messages?
            this.gun.user(uri).get(`iris`).get(`messagesByDistance`).map((val, key) => {
              const d = Number.parseInt(key.split(`:`)[0]);
              if (!isNaN(d) && d <= this.options.indexSync.subscribe.maxMsgDistance) {
                SignedMessage.fromSig(val).then(msg => {
                  if (this.options.indexSync.msgTypes.all ||
                    Object.prototype.hasOwnProperty.call(this.options.indexSync.msgTypes, msg.signedData.type)) {
                    this.addMessage(msg, {checkIfExists: true});
                  }
                });
              }
            });
            this.gun.user(uri).get(`iris`).get(`reactions`).map((reaction, msgHash) => {
              this.gun.get(`messagesByHash`).get(msgHash).get(`reactions`).get(uri).put(reaction);
              this.gun.get(`messagesByHash`).get(msgHash).get(`reactions`).get(uri).put(reaction);
            });
          }
        });
      }, 5000); // TODO: this should be made to work without timeout
    }
  }

  debug() {
    const d = (util.isNode && process.env.DEBUG) ? process.env.DEBUG === `true` : this.options.debug;
    if (d) {
      console.log.apply(console, arguments);
    }
  }

  static getMsgIndexKey(msg) {
    let distance = parseInt(msg.distance);
    distance = Number.isNaN(distance) ? 99 : distance;
    distance = (`00${distance}`).substring(distance.toString().length); // pad with zeros
    const key = `${distance}:${Math.floor(Date.parse(msg.signedData.time || msg.signedData.timestamp))}:${(msg.ipfs_hash || msg.hash).substr(0, 9)}`;
    return key;
  }

  // TODO: GUN indexing module that does this automatically
  static async getMsgIndexKeys(msg) {
    const keys = {};
    let distance = parseInt(msg.distance);
    distance = Number.isNaN(distance) ? 99 : distance;
    distance = (`00${distance}`).substring(distance.toString().length); // pad with zeros
    const timestamp = Math.floor(Date.parse(msg.signedData.time || msg.signedData.timestamp));
    const hash = await msg.getHash();
    const hashSlice = hash.substr(0, 9);

    if (msg.signedData.type === `chat`) {
      if (msg.signedData.recipient.uuid) {
        keys.chatMessagesByUuid = {};
        keys.chatMessagesByUuid[msg.signedData.recipient.uuid] = `${msg.signedData.time}:${hashSlice}`;
      }
      return keys;
    }

    keys.messagesByHash = [hash];
    keys.messagesByTimestamp = [`${timestamp}:${hashSlice}`];
    keys.messagesByDistance = [`${distance}:${keys.messagesByTimestamp[0]}`];
    keys.messagesByType = [`${msg.signedData.type}:${timestamp}:${hashSlice}`];

    keys.messagesByAuthor = {};
    const authors = msg.getAuthorArray();
    for (let i = 0;i < authors.length;i++) {
      if (authors[i].isUniqueType()) {
        keys.messagesByAuthor[authors[i].uri()] = `${msg.signedData.timestamp}:${hashSlice}`;
      }
    }
    keys.messagesByRecipient = {};
    const recipients = msg.getRecipientArray();
    for (let i = 0;i < recipients.length;i++) {
      if (recipients[i].isUniqueType()) {
        keys.messagesByRecipient[recipients[i].uri()] = `${msg.signedData.timestamp}:${hashSlice}`;
      }
    }

    if ([`verification`, `unverification`].indexOf(msg.signedData.type) > -1) {
      keys.verificationsByRecipient = {};
      for (let i = 0;i < recipients.length;i++) {
        const r = recipients[i];
        if (!r.isUniqueType()) {
          continue;
        }
        for (let j = 0;j < authors.length;j++) {
          const a = authors[j];
          if (!a.isUniqueType()) {
            continue;
          }
          keys.verificationsByRecipient[r.uri()] = a.uri();
        }
      }
    } else if (msg.signedData.type === `rating`) {
      keys.ratingsByRecipient = {};
      for (let i = 0;i < recipients.length;i++) {
        const r = recipients[i];
        if (!r.isUniqueType()) {
          continue;
        }
        for (let j = 0;j < authors.length;j++) {
          const a = authors[j];
          if (!a.isUniqueType()) {
            continue;
          }
          keys.ratingsByRecipient[r.uri()] = a.uri();
        }
      }
    }
    return keys;
  }

  async getContactIndexKeys(contact, hash) {
    const indexKeys = {identitiesByTrustDistance: [], identitiesBySearchKey: []};
    let d;
    if (contact.keyID && this.rootContact.equals(contact.linkTo)) { // TODO: contact is a gun instance, no linkTo
      d = 0;
    } else {
      d = await contact.get(`trustDistance`).then();
    }

    function addIndexKey(a) {
      if (!(a && a.value && a.type)) { // TODO: this sometimes returns undefined
        return;
      }
      let distance = d !== undefined ? d : parseInt(a.dist);
      distance = Number.isNaN(distance) ? 99 : distance;
      distance = (`00${distance}`).substring(distance.toString().length); // pad with zeros
      const v = a.value || a[1];
      const n = a.type || a[0];
      const value = encodeURIComponent(v);
      const lowerCaseValue = encodeURIComponent(v.toLowerCase());
      const name = encodeURIComponent(n);
      let key = `${value}:${name}`;
      let lowerCaseKey = `${lowerCaseValue}:${name}`;
      if (!Attribute.isUniqueType(n)) { // allow for multiple index keys with same non-unique attribute
        key = `${key}:${hash.substr(0, 9)}`;
        lowerCaseKey = `${lowerCaseKey}:${hash.substr(0, 9)}`;
      }
      indexKeys.identitiesBySearchKey.push(key);
      indexKeys.identitiesByTrustDistance.push(`${distance}:${key}`);
      if (key !== lowerCaseKey) {
        indexKeys.identitiesBySearchKey.push(lowerCaseKey);
        indexKeys.identitiesByTrustDistance.push(`${distance}:${lowerCaseKey}`);
      }
      if (v.indexOf(` `) > -1) {
        const words = v.toLowerCase().split(` `);
        for (let l = 0;l < words.length;l += 1) {
          let k = `${encodeURIComponent(words[l])}:${name}`;
          if (!Attribute.isUniqueType(n)) {
            k = `${k}:${hash.substr(0, 9)}`;
          }
          indexKeys.identitiesBySearchKey.push(k);
          indexKeys.identitiesByTrustDistance.push(`${distance}:${k}`);
        }
      }
      if (key.match(/^http(s)?:\/\/.+\/[a-zA-Z0-9_]+$/)) {
        const split = key.split(`/`);
        indexKeys.identitiesBySearchKey.push(split[split.length - 1]);
        indexKeys.identitiesByTrustDistance.push(`${distance}:${split[split.length - 1]}`);
      }
    }

    if (this.rootContact.equals(contact.keyID)) {
      addIndexKey(contact.keyID);
    }

    const attrs = await Contact.getAttrs(contact);
    Object.values(attrs).map(addIndexKey);

    return indexKeys;
  }

  /**
  *
  */
  async addContact(attributes, follow = true) {
    // TODO: add uuid to attributes
    let msg;
    if (follow) {
      msg = await SignedMessage.createRating({recipient: attributes, rating: 1});
    } else {
      msg = await SignedMessage.createVerification({recipient: attributes});
    }
    return this.addMessage(msg);
  }

  /*
  * Get an contact referenced by an identifier.
  * get(type, value)
  * get(Attribute)
  * get(value) - guesses the type or throws an error
  * @returns {Contact} contact that is connected to the identifier param
  */
  getContact(a: String, b: String, reload = false) {
    if (!a) {
      throw new Error(`getContact failed: first param must be defined`);
    }
    let attr = a;
    if (a.constructor.name !== `Attribute`) {
      let type, value;
      if (b) {
        type = a;
        value = b;
      } else {
        value = a;
        type = Attribute.guessTypeOf(value);
      }
      attr = new Attribute(type, value);
    }
    if (reload) {
      // 1) get verifications connecting attr to other attributes
      // 2) recurse
      // 3) get messages received by this list of attributes
      // 4) calculate stats
      // 5) update contact index entry
      const o = {
        attributes: {},
        sent: {},
        received: {},
        receivedPositive: 0,
        receivedNeutral: 0,
        receivedNegative: 0,
        sentPositive: 0,
        sentNeutral: 0,
        sentNegative: 0
      };
      const node = this.gun.get(`identities`).set(o);
      const updateContactByLinkedAttribute = attribute => {
        this.gun.get(`verificationsByRecipient`).get(attribute.uri()).map().once(val => {
          const m = SignedMessage.fromSig(val);
          const recipients = m.getRecipientArray();
          for (let i = 0;i < recipients.length;i++) {
            const a2 = recipients[i];
            if (!Object.prototype.hasOwnProperty.call(o.attributes), a2.uri()) {
              // TODO remove attribute from contact if not enough verifications / too many unverifications
              o.attributes[a2.uri()] = a2;
              this.gun.get(`messagesByRecipient`).get(a2.uri()).map().once(async val => {
                const m2 = SignedMessage.fromSig(val);
                const m2hash = await m2.getHash();
                if (!Object.prototype.hasOwnProperty.call(o.received.hasOwnProperty, m2hash)) {
                  o.received[m2hash] = m2;
                  if (m2.isPositive()) {
                    o.receivedPositive++;
                    m2.getAuthor(this).gun.get(`trustDistance`).on(d => {
                      if (typeof d === `number`) {
                        if (typeof o.trustDistance !== `number` || o.trustDistance > d + 1) {
                          o.trustDistance = d + 1;
                          node.get(`trustDistance`).put(d + 1);
                        }
                      }
                    });
                  } else if (m2.isNegative()) {
                    o.receivedNegative++;
                  } else {
                    o.receivedNeutral++;
                  }
                  node.put(o);
                }
              });
              this.gun.get(`messagesByAuthor`).get(a2.uri()).map().once(async val => {
                const m2 = SignedMessage.fromSig(val);
                const m2hash = await m2.getHash();
                if (!Object.prototype.hasOwnProperty.call(o.sent, m2hash)) {
                  o.sent[m2hash] = m2;
                  if (m2.isPositive()) {
                    o.sentPositive++;
                  } else if (m2.isNegative()) {
                    o.sentNegative++;
                  } else {
                    o.sentNeutral++;
                  }
                  node.put(o);
                }
              });
              updateContactByLinkedAttribute(a2);
            }
          }
        });
      };
      updateContactByLinkedAttribute(attr);
      if (this.writable) {
        this._addContactToIndexes(node);
      }
      return new Contact(node, attr, this);
    } else {
      return new Contact(this.gun.get(`identitiesBySearchKey`).get(attr.uri()), attr, this);
    }
  }

  /**
  *
  */
  getContacts(opt = {}) { // cursor // TODO: param 'exact', type param
    if (opt.value) {
      if (opt.type) {
        return this.getContact(opt.type, opt.value, opt.reload);
      } else {
        return this.getContact(opt.value);
      }
    }
    opt.query = opt.query || '';
    const seen = {};
    function searchTermCheck(key) {
      const arr = key.split(`:`);
      if (arr.length < 2) { return false; }
      const keyValue = arr[0];
      const keyType = arr[1];
      if (keyValue.indexOf(encodeURIComponent(opt.query)) !== 0) { return false; }
      if (opt.type && keyType !== opt.type) { return false; }
      return true;
    }
    const node = this.gun.get(`identitiesBySearchKey`);
    node.map().on((id, key) => {
      if (Object.keys(seen).length >= opt.limit) {
        // TODO: turn off .map cb
        return;
      }
      if (!searchTermCheck(key)) { return; }
      const soul = Gun.node.soul(id);
      if (soul && !Object.prototype.hasOwnProperty.call(seen, soul)) {
        seen[soul] = true;
        const contact = new Contact(node.get(key), undefined, this);
        contact.cursor = key;
        opt.callback(contact);
      }
    });
    if (this.options.indexSync.query.enabled) {
      this.gun.get(`trustedIndexes`).map().once((val, key) => {
        if (val) {
          this.gun.user(key).get(`iris`).get(`identitiesBySearchKey`).map().on((id, k) => {
            if (Object.keys(seen).length >= opt.limit) {
              // TODO: turn off .map cb
              return;
            }
            if (!searchTermCheck(key)) { return; }
            const soul = Gun.node.soul(id);
            if (soul && !Object.prototype.hasOwnProperty.call(seen, soul)) {
              seen[soul] = true;
              opt.callback(
                new Contact(this.gun.user(key).get(`iris`).get(`identitiesBySearchKey`).get(k), undefined, this)
              );
            }
          });
        }
      });
    }
  }

  /**
  * @returns {Contact} root contact (center of the social graph, trustDistance == 0)
  */
  getRootContact() {
    return new Contact(this.gun.get(`identitiesBySearchKey`).get(this.rootContact.uri()), undefined, this);
  }

  /**
  * Return existing chats and listen to new chats initiated by friends.
  * Like Channel.getChannels(), but also listens to chats initiated by friends.
  */
  async getChannels(callback) {
    Channel.getChannels(this.gun, this.options.keypair, callback);
    this.gun.get(`trustedIndexes`).map().on(async (value, pub) => {
      if (value && pub) {
        const theirSecretChannelId = await Channel.getTheirSecretChannelId(this.gun, pub, this.options.keypair);
        this.gun.user(pub).get(`chats`).get(theirSecretChannelId).on(v => {
          if (v) {
            callback(pub);
          }
        });
      }
    });
  }

  async _getMsgs(msgIndex, callback, limit, cursor, desc, filter) {
    let results = 0;
    async function resultFound(result) {
      if (results >= limit) { return; }
      const msg = await SignedMessage.fromSig(result.value);
      if (filter && !filter(msg)) { return; }
      results++;
      msg.cursor = result.key;
      if (result.value && result.value.ipfsUri) {
        msg.ipfsUri = result.value.ipfsUri;
      }
      msg.gun = msgIndex.get(result.key);
      callback(msg);
    }
    searchText(msgIndex, resultFound, ``, undefined, cursor, desc);
  }

  async _addContactToIndexes(id) {
    if (typeof id === `undefined`) {
      const e = new Error(`id is undefined`);
      console.error(e.stack);
      throw e;
    }
    const hash = Gun.node.soul(id) || id._ && id._.link || `todo`;
    const indexKeys = await this.getContactIndexKeys(id, hash.substr(0, 6));

    const indexes = Object.keys(indexKeys);
    for (let i = 0;i < indexes.length;i++) {
      const index = indexes[i];
      for (let j = 0;j < indexKeys[index].length;j++) {
        const key = indexKeys[index][j];
        // this.debug(`adding to index ${index} key ${key}, saving data: ${id}`);
        this.gun.get(index).get(key).put(id); // FIXME: Check, why this can't be `await`ed for in tests? [index.ready promise gets stuck]
      }
    }
  }

  async _getSentMsgs(contact, options) {
    this._getMsgs(contact.gun.get(`sent`), options.callback, options.limit, options.cursor, true, options.filter);
    if (this.options.indexSync.query.enabled) {
      this.gun.get(`trustedIndexes`).map().once((val, key) => {
        if (val) {
          const n = this.gun.user(key).get(`iris`).get(`messagesByAuthor`).get(contact.linkTo.uri());
          this._getMsgs(n, options.callback, options.limit, options.cursor, false, options.filter);
        }
      });
    }
  }

  async _getReceivedMsgs(contact, options) {
    this._getMsgs(contact.gun.get(`received`), options.callback, options.limit, options.cursor, true, options.filter);
    if (this.options.indexSync.query.enabled) {
      this.gun.get(`trustedIndexes`).map().once((val, key) => {
        if (val) {
          const n = this.gun.user(key).get(`iris`).get(`messagesByRecipient`).get(contact.linkTo.uri());
          this._getMsgs(n, options.callback, options.limit, options.cursor, false, options.filter);
        }
      });
    }
  }

  async getChatMsgs(uuid, options) {
    this._getMsgs(this.gun.get(`chatMessagesByUuid`).get(uuid), options.callback, options.limit, options.cursor, true, options.filter);
    const callback = msg => {
      if (options.callback) {
        options.callback(msg);
      }
      this.addMessage(msg, {checkIfExists: true});
    };
    this.gun.get(`trustedIndexes`).map().once((val, key) => {
      if (val) {
        const n = this.gun.user(key).get(`iris`).get(`chatMessagesByUuid`).get(uuid);
        this._getMsgs(n, callback, options.limit, options.cursor, false, options.filter);
      }
    });
  }

  async _getAttributeTrustDistance(a) {
    if (!Attribute.isUniqueType(a.type)) {
      return;
    }
    if (this.rootContact.equals(a)) {
      return 0;
    }
    const id = this.getContact(a);
    let d = await id.gun.get(`trustDistance`).then();
    if (isNaN(d)) {
      d = Infinity;
    }
    return d;
  }

  async _getMsgTrustDistance(msg) {
    let shortestDistance = Infinity;
    const signerAttr = new Attribute(`keyID`, msg.getSignerKeyID());
    if (!signerAttr.equals(this.rootContact)) {
      const signer = this.getContact(signerAttr);
      const d = await signer.gun.get(`trustDistance`).then();
      if (isNaN(d)) {
        return;
      }
    }
    for (const a of msg.getAuthorArray()) {
      const d = await this._getAttributeTrustDistance(a);
      if (d < shortestDistance) {
        shortestDistance = d;
      }
    }
    return shortestDistance < Infinity ? shortestDistance : undefined;
  }

  async _updateMsgRecipientContact(msg, msgIndexKey, recipient) {
    const hash = recipient._ && recipient._.link || `todo`;
    const contactIndexKeysBefore = await this.getContactIndexKeys(recipient, hash.substr(0, 6));
    const attrs = await Contact.getAttrs(recipient);
    if ([`verification`, `unverification`].indexOf(msg.signedData.type) > -1) {
      const isVerification = msg.signedData.type === `verification`;
      for (const a of msg.getRecipientArray()) {
        let hasAttr = false;
        const v = {
          verifications: isVerification ? 1 : 0,
          unverifications: isVerification ? 0 : 1
        };
        Object.keys(attrs).forEach(k => {
          // TODO: if author is self, mark as self verified
          // TODO: only 1 verif / unverif per author
          if (a.equals(attrs[k])) {
            attrs[k].verifications = (attrs[k].verifications || 0) + v.verifications;
            attrs[k].unverifications = (attrs[k].unverifications || 0) + v.unverifications;
            hasAttr = true;
          }
        });
        if (!hasAttr) {
          attrs[a.uri()] = Object.assign({type: a.type, value: a.value}, v);
        }
        if (msg.goodVerification) {
          if (isVerification) {
            attrs[a.uri()].wellVerified = true;
          } else {
            attrs[a.uri()].wellUnverified = true;
          }
        }
      }
      const mva = Contact.getMostVerifiedAttributes(attrs);
      recipient.get(`mostVerifiedAttributes`).put(mva); // TODO: why this needs to be done twice to register?
      recipient.get(`mostVerifiedAttributes`).put(mva);
      const k = (mva.keyID && mva.keyID.attribute.value) || (mva.uuid && mva.uuid.attribute.value) || hash;
      console.log('k', k);
      recipient.get(`attrs`).put(this.gun.user().top(`${k  }/attrs`));
      recipient.get(`attrs`).put(attrs);
      recipient.get(`attrs`).put(attrs);
    }
    if (msg.signedData.type === `rating`) {
      const id = await recipient.then();
      id.receivedPositive = (id.receivedPositive || 0);
      id.receivedNegative = (id.receivedNegative || 0);
      id.receivedNeutral = (id.receivedNeutral || 0);
      if (msg.isPositive()) {
        if (typeof id.trustDistance !== `number` || msg.distance + 1 < id.trustDistance) {
          recipient.get(`trustDistance`).put(msg.distance + 1);
        }
        id.receivedPositive++;
      } else {
        if (msg.distance < id.trustDistance) {
          recipient.get(`trustDistance`).put(false); // TODO: this should take into account the aggregate score of the contact
        }
        if (msg.isNegative()) {
          id.receivedNegative++;
        } else {
          id.receivedNeutral++;
        }
      }

      recipient.put({
        receivedPositive: id.receivedPositive,
        receivedNegative: id.receivedNegative,
        receivedNeutral: id.receivedNeutral,
      });

      if (msg.signedData.context === `verifier`) {
        if (msg.distance === 0) {
          if (msg.isPositive) {
            recipient.get(`scores`).get(msg.signedData.context).get(`score`).put(10);
          } else if (msg.isNegative()) {
            recipient.get(`scores`).get(msg.signedData.context).get(`score`).put(0);
          } else {
            recipient.get(`scores`).get(msg.signedData.context).get(`score`).put(-10);
          }
        }
      } else {
        // TODO: generic context-dependent score calculation
      }
    }
    const obj = {sig: msg.sig, pubKey: msg.pubKey};
    if (msg.ipfsUri) {
      obj.ipfsUri = msg.ipfsUri;
    }

    recipient.get(`received`).get(msgIndexKey).put(obj);
    recipient.get(`received`).get(msgIndexKey).put(obj);

    const contactIndexKeysAfter = await this.getContactIndexKeys(recipient, hash.substr(0, 6));
    const indexesBefore = Object.keys(contactIndexKeysBefore);
    for (let i = 0;i < indexesBefore.length;i++) {
      const index = indexesBefore[i];
      for (let j = 0;j < contactIndexKeysBefore[index].length;j++) {
        const key = contactIndexKeysBefore[index][j];
        if (!contactIndexKeysAfter[index] || contactIndexKeysAfter[index].indexOf(key) === -1) {
          this.gun.get(index).get(key).put(null);
        }
      }
    }
  }

  async _updateMsgAuthorContact(msg, msgIndexKey, author) {
    if (msg.signedData.type === `rating`) {
      const id = await author.then();
      id.sentPositive = (id.sentPositive || 0);
      id.sentNegative = (id.sentNegative || 0);
      id.sentNeutral = (id.sentNeutral || 0);
      if (msg.isPositive()) {
        id.sentPositive++;
      } else if (msg.isNegative()) {
        id.sentNegative++;
      } else {
        id.sentNeutral++;
      }
      author.get(`sentPositive`).put(id.sentPositive);
      author.get(`sentNegative`).put(id.sentNegative);
      author.get(`sentNeutral`).put(id.sentNeutral);
    }
    const obj = {sig: msg.sig, pubKey: msg.pubKey};
    if (msg.ipfsUri) {
      obj.ipfsUri = msg.ipfsUri;
    }
    author.get(`sent`).get(msgIndexKey).put(obj); // for some reason, doesn't work unless I do it twice
    author.get(`sent`).get(msgIndexKey).put(obj);
    return;
  }

  async _updateContactProfilesByMsg(msg, authorIdentities, recipientIdentities) {
    let start;
    let msgIndexKey = SocialNetwork.getMsgIndexKey(msg);
    msgIndexKey = msgIndexKey.substr(msgIndexKey.indexOf(`:`) + 1);
    const ids = Object.values(Object.assign({}, authorIdentities, recipientIdentities));
    for (let i = 0;i < ids.length;i++) { // add new identifiers to contact
      if (Object.prototype.hasOwnProperty.call(recipientIdentities, ids[i].gun[`_`].link)) {
        start = new Date();
        await this._updateMsgRecipientContact(msg, msgIndexKey, ids[i].gun);
        this.debug((new Date()) - start, `ms _updateMsgRecipientContact`);
      }
      if (Object.prototype.hasOwnProperty.call(authorIdentities, ids[i].gun[`_`].link)) {
        start = new Date();
        await this._updateMsgAuthorContact(msg, msgIndexKey, ids[i].gun);
        this.debug((new Date()) - start, `ms _updateMsgAuthorContact`);
      }
      start = new Date();
      await this._addContactToIndexes(ids[i].gun);
      this.debug((new Date()) - start, `ms _addContactToIndexes`);
    }
  }

  async removeTrustedIndex(gunUri) {
    this.gun.get(`trustedIndexes`).get(gunUri).put(null);
  }

  async addTrustedIndex(gunUri,
    maxMsgsToCrawl = this.options.indexSync.importOnAdd.maxMsgCount,
  ) { // maxMsgDistance = this.options.indexSync.importOnAdd.maxMsgDistance
    if (gunUri === this.rootContact.value) {
      return;
    }
    const exists = await this.gun.get(`trustedIndexes`).get(gunUri).then();
    if (exists) {
      return;
    }
    this.gun.get(`trustedIndexes`).get(gunUri).put(true);
    const msgs = [];
    if (this.options.indexSync.importOnAdd.enabled) {
      await util.timeoutPromise(new Promise(resolve => {
        const gun = this.gun.user(gunUri).get(`iris`);
        const callback = msg => {
          msgs.push(msg);
          if (msgs.length >= maxMsgsToCrawl) {
            resolve();
          }
        };
        const messages = new Collection({gun, class: SignedMessage, indexes: [`trustDistance`]});
        messages.get({callback, orderBy: `trustDistance`, desc: false});
      }), 10000);
      this.debug(`adding`, msgs.length, `msgs`);
      this.addMessages(msgs);
    }
  }

  async _updateContactIndexesByMsg(msg) {
    let recipientIdentities = {};
    const authorIdentities = {};
    let selfAuthored = false;
    let start;
    start = new Date();
    for (const a of msg.getAuthorArray()) {
      const id = this.getContact(a);
      let start2 = new Date();
      const td = await id.gun.get(`trustDistance`).then();
      this.debug((new Date()) - start2, `ms get trustDistance`);
      if (!isNaN(td)) {
        authorIdentities[id.gun[`_`].link] = id;
        start2 = new Date();
        const scores = await id.gun.get(`scores`).then();
        this.debug((new Date()) - start2, `ms get scores`);
        if (scores && scores.verifier && msg.signedData.type === `verification`) {
          msg.goodVerification = true;
        }
        if (td === 0) {
          selfAuthored = true;
        }
      }
    }
    this.debug((new Date()) - start, `ms getAuthorArray`);
    if (!Object.keys(authorIdentities).length) {
      return; // unknown author, do nothing
    }
    start = new Date();
    for (const a of msg.getRecipientArray()) {
      const id = this.getContact(a);
      const td = await id.gun.get(`trustDistance`).then();

      if (!isNaN(td)) {
        recipientIdentities[id.gun[`_`].link] = id;
      }
      if (selfAuthored && a.type === `keyID` && a.value !== this.rootContact.value) { // TODO: not if already added - causes infinite loop?
        if (msg.isPositive()) {
          this.addTrustedIndex(a.value);
        } else {
          this.removeTrustedIndex(a.value);
        }
      }
    }
    this.debug((new Date()) - start, `ms getRecipientArray`);
    if (!msg.signedData.recipient) { // message to self
      recipientIdentities = authorIdentities;
    }
    if (!Object.keys(recipientIdentities).length) { // recipient is previously unknown
      const attrs = {};
      let u;
      for (const a of msg.getRecipientArray()) {
        attrs[a.uri()] = a;
        if (!u && a.isUniqueType()) {
          u = a;
        }
      }
      const linkTo = Contact.getLinkTo(attrs);
      const trustDistance = msg.isPositive() && typeof msg.distance === `number` ? msg.distance + 1 : false;
      const start = new Date();
      const node = this.gun.get(`identitiesBySearchKey`).get(u.uri());
      node.put({a: 1}); // {a:1} because inserting {} causes a "no signature on data" error from gun
      const id = Contact.create(node, {attrs, linkTo, trustDistance}, this);
      this.debug((new Date) - start, `ms contact.create`);


      // TODO: take msg author trust into account
      recipientIdentities[id.gun[`_`].link] = id;
    }

    return this._updateContactProfilesByMsg(msg, authorIdentities, recipientIdentities);
  }

  /**
  * Add a message to messagesByTimestamp and other relevant indexes. Update identities in the web of trust according to message data.
  *
  * @param msg SignedMessage (or an array of messages) to add to the index
  */
  async addMessage(msg: SignedMessage, options = {}) {
    if (!this.writable) {
      throw new Error(`Cannot write to a read-only index (initialized with options.pubKey)`);
    }
    if (Array.isArray(msg)) {
      return this.addMessages(msg, options);
    }
    let start;
    if (msg.constructor.name !== `SignedMessage`) {
      throw new Error(`addMessage failed: param must be a SignedMessage, received ${msg.constructor.name}`);
    }
    const hash = await msg.getHash();
    if (true === options.checkIfExists) {
      const exists = await this.gun.get(`messagesByHash`).get(hash).then();
      if (exists) {
        return;
      }
    }
    const obj = {sig: msg.sig, pubKey: msg.pubKey};
    //const node = this.gun.get(`messagesByHash`).get(hash).put(obj);
    const node = this.gun.back(-1).get(`messagesByHash`).get(hash).put(obj); // TODO: needs fix to https://github.com/amark/gun/issues/719
    start = new Date();
    const d = await this._getMsgTrustDistance(msg);
    msg.distance = Object.prototype.hasOwnProperty.call(msg, `distance`) ? msg.distance : d;  // eslint-disable-line require-atomic-updates
    this.debug(`----`);
    this.debug((new Date()) - start, `ms _getMsgTrustDistance`);
    if (msg.distance === undefined) {
      return false; // do not save messages from untrusted author
    }
    if (msg.signedData.replyTo) {
      this.gun.back(-1).get(`messagesByHash`).get(msg.signedData.replyTo).get(`replies`).get(hash).put(node);
      this.gun.back(-1).get(`messagesByHash`).get(msg.signedData.replyTo).get(`replies`).get(hash).put(node);
    }
    if (msg.signedData.sharedMsg) {
      this.gun.back(-1).get(`messagesByHash`).get(msg.signedData.sharedMsg).get(`shares`).get(hash).put(node);
      this.gun.back(-1).get(`messagesByHash`).get(msg.signedData.sharedMsg).get(`shares`).get(hash).put(node);
    }
    start = new Date();

    this.messages.put(msg);


    // TODO: this should be moved to Collection
    const indexKeys = SocialNetwork.getMsgIndexKeys(msg);
    this.debug((new Date()) - start, `ms getMsgIndexKeys`);
    for (const index in indexKeys) {
      if (Array.isArray(indexKeys[index])) {
        for (let i = 0;i < indexKeys[index].length;i++) {
          const key = indexKeys[index][i];
          // this.debug(`adding to index ${index} key ${key}`);
          this.gun.get(index).get(key).put(node);
          this.gun.get(index).get(key).put(node); // umm, what? doesn't work unless I write it twice
        }
      } else if (typeof indexKeys[index] === `object`) {
        for (const key in indexKeys[index]) {
          this.gun.get(index).get(key).get(indexKeys[index][key]).put(node);
          this.gun.get(index).get(key).get(indexKeys[index][key]).put(node);
        }
      }
    }


    if (this.options.ipfs) {
      try {
        const ipfsUri = await msg.saveToIpfs(this.options.ipfs);
        this.gun.get(`messagesByHash`).get(ipfsUri).put(node);
        this.gun.get(`messagesByHash`).get(ipfsUri).put(node);
        this.gun.get(`messagesByHash`).get(ipfsUri).put({ipfsUri});
      } catch (e) {
        console.error(`adding msg ${msg} to ipfs failed: ${e}`);
      }
    }
    if (msg.signedData.type !== `chat`) {
      start = new Date();
      await this._updateContactIndexesByMsg(msg);
      this.debug((new Date()) - start, `ms _updateContactIndexesByMsg`);
    }
    return true;
  }


  /**
  * Alias to socialNetwork.messages.get(opt) (but with opt.orderBy = 'time')
  * @param {Object} opt {hash, orderBy, callback, limit, cursor, desc, filter}
  */
  async getMessages(opt) {
    if (opt.hash) {
      return this.messages.get({id: opt.hash});
    }
    opt.orderBy = opt.orderBy || `time`;
    return this.messages.get(opt);
  }


  /*
  * Add a list of messages to the index.
  * Useful for example when adding a new WoT dataset that contains previously
  * unknown authors.
  *
  * Iteratively performs sorted merge joins on [previously known contacts] and
  * [new msgs authors], until all messages from within the WoT have been added.
  *
  * @param {Array} msgs an array of messages.
  * @returns {boolean} true on success
  */
  async addMessages(msgs) {
    if (!this.writable) {
      throw new Error(`Cannot write to a read-only index (initialized with options.pubKey)`);
    }
    const msgsByAuthor = {};
    if (Array.isArray(msgs)) {
      this.debug(`sorting ${msgs.length} messages onto a search tree...`);
      for (let i = 0;i < msgs.length;i++) {
        for (const a of msgs[i].getAuthorArray()) {
          if (a.isUniqueType()) {
            const hash = msgs[i].getHash();
            const key = `${a.uri()}:${hash}`;
            msgsByAuthor[key] = msgs[i];
          }
        }
      }
      this.debug(`...done`);
    } else {
      throw `msgs param must be an array`;
    }
    const msgAuthors = Object.keys(msgsByAuthor).sort();
    if (!msgAuthors.length) {
      return;
    }
    let initialMsgCount, msgCountAfterwards;
    const index = this.gun.get(`identitiesBySearchKey`);
    do {
      const knownIdentities = [];
      let stop = false;
      searchText(index, result => {
        if (stop) { return; }
        knownIdentities.push(result);
      }, ``);
      await new Promise(r => setTimeout(r, 2000)); // wait for results to accumulate
      stop = true;
      knownIdentities.sort((a, b) => {
        if (a.key === b.key) {
          return 0;
        } else if (a.key > b.key) {
          return 1;
        } else {
          return -1;
        }
      });
      let i = 0;
      let author = msgAuthors[i];
      let knownContact = knownIdentities.shift();
      initialMsgCount = msgAuthors.length;
      // sort-merge join identitiesBySearchKey and msgsByAuthor
      while (author && knownContact) {
        if (author.indexOf(knownContact.key) === 0) {
          try {
            await util.timeoutPromise(this.addMessage(msgsByAuthor[author], {checkIfExists: true}), 10000);
          } catch (e) {
            this.debug(`adding failed:`, e, JSON.stringify(msgsByAuthor[author], null, 2));
          }
          msgAuthors.splice(i, 1);
          author = i < msgAuthors.length ? msgAuthors[i] : undefined;
          //knownContact = knownIdentities.shift();
        } else if (author < knownContact.key) {
          author = i < msgAuthors.length ? msgAuthors[++i] : undefined;
        } else {
          knownContact = knownIdentities.shift();
        }
      }
      msgCountAfterwards = msgAuthors.length;
    } while (msgCountAfterwards !== initialMsgCount);
    return true;
  }

  /*
  * @returns {Object} message matching the hash
  */
  getMessageByHash(hash) {
    const isIpfsUri = hash.indexOf(`Qm`) === 0;
    return new Promise(resolve => {
      const resolveIfHashMatches = async (d, fromIpfs) => {
        const obj = typeof d === `object` ? d : JSON.parse(d);
        const m = await SignedMessage.fromSig(obj);
        let h;
        let republished = false;
        if (fromIpfs) {
          return resolve(m);
        } else if (isIpfsUri && this.options.ipfs) {
          h = await m.saveToIpfs(this.options.ipfs);
          republished = true;
        } else {
          h = await m.getHash();
        }
        if (h === hash || (isIpfsUri && !this.options.ipfs)) { // does not check hash validity if it's an ipfs uri and we don't have ipfs
          if (!fromIpfs && this.options.ipfs && this.writable && !republished) {
            m.saveToIpfs(this.options.ipfs).then(ipfsUri => {
              obj.ipfsUri = ipfsUri;
              this.gun.get(`messagesByHash`).get(hash).put(obj);
              this.gun.get(`messagesByHash`).get(ipfsUri).put(obj);
            });
          }
          resolve(m);
        } else {
          console.error(`queried index for message ${hash} but received ${h}`);
        }
      };
      if (isIpfsUri && this.options.ipfs) {
        this.options.ipfs.cat(hash).then(file => {
          const s = this.options.ipfs.types.Buffer.from(file).toString(`utf8`);
          this.debug(`got msg ${hash} from ipfs`);
          resolveIfHashMatches(s, true);
        });
      }
      this.gun.get(`messagesByHash`).get(hash).on(d => {
        this.debug(`got msg ${hash} from own gun index`);
        resolveIfHashMatches(d);
      });
      if (this.options.indexSync.query.enabled) {
        this.gun.get(`trustedIndexes`).map().once((val, key) => {
          if (val) {
            this.gun.user(key).get(`iris`).get(`messagesByHash`).get(hash).on(d => {
              this.debug(`got msg ${hash} from friend's gun index ${val}`);
              resolveIfHashMatches(d);
            });
          }
        });
      }
    });
  }

  /*
  * @returns {Array} list of messages
  */
  getMessagesByTimestamp(callback, limit, cursor, desc = true, filter) {
    const seen = {};
    const cb = async msg => {
      if ((!limit || Object.keys(seen).length < limit) && !Object.prototype.hasOwnProperty.call(seen, msg.hash)) {
        seen[msg.hash] = true;
        callback(msg);
      }
    };

    this._getMsgs(this.gun.get(`messagesByTimestamp`), cb, limit, cursor, desc, filter);
    if (this.options.indexSync.query.enabled) {
      this.gun.get(`trustedIndexes`).map().once((val, key) => {
        if (val) {
          const n = this.gun.user(key).get(`iris`).get(`messagesByTimestamp`);
          this._getMsgs(n, cb, limit, cursor, desc, filter);
        }
      });
    }
  }

  /*
  * @returns {Array} list of messages
  */
  getMessagesByDistance(callback, limit, cursor, desc, filter) {
    const seen = {};
    const cb = msg => {
      if (!Object.prototype.hasOwnProperty.call(seen, msg.hash)) {
        if ((!limit || Object.keys(seen).length <= limit) && !Object.prototype.hasOwnProperty.call(seen, msg.hash)) {
          seen[msg.hash] = true;
          callback(msg);
        }
      }
    };
    this._getMsgs(this.gun.get(`messagesByDistance`), cb, limit, cursor, desc, filter);
    if (this.options.indexSync.query.enabled) {
      this.gun.get(`trustedIndexes`).map().once((val, key) => {
        if (val) {
          const n = this.gun.user(key).get(`iris`).get(`messagesByDistance`);
          this._getMsgs(n, cb, limit, cursor, desc, filter);
        }
      });
    }
  }
}

export default SocialNetwork;
