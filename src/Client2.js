'use strict';

const puppeteer = require('puppeteer');
const moduleRaid = require('@pedroslopez/moduleraid/moduleraid');
const jsQR = require('jsqr');

const Util = require('./util/Util');
const { WhatsWebURL, UserAgent, DefaultOptions, Events, WAState } = require('./util/Constants');
const { ExposeStore, LoadUtils } = require('./util/Injected');
const ChatFactory = require('./factories/ChatFactory');
const ContactFactory = require('./factories/ContactFactory');
const { ClientInfo, Message, MessageMedia, Contact, Location, GroupNotification } = require('./structures');

var mysql = require('mysql');

var con = mysql.createConnection({
    host: "179.188.38.36",
    user: "andre.seremeta",
    password: "AtriaABC28*Andre",
    port: 3306,
    database: "praweb"
});


class Client {
    constructor(options = {}) {
        this.options = Util.mergeDefault(DefaultOptions, options);

        this.pupBrowser = null;
        this.pupPage = null;
    }

    /*
    *  Verify QrCode
    */

    verifyQrCode(numero) {
        var token;
        return new Promise((resolve, reject) => {

            con.query("SELECT * FROM praweb.numero_token where numero = '" + numero + "'", function (err, result) {
                if (err) {
                    reject(err)
                }
                
                if (result && result.length) {
                    // console.log("Result: " + JSON.stringify(result));
                    let aux = JSON.stringify(result);
                    token = JSON.parse(result[0].extra);
                }

                if (token) {
                    console.log("br")
                    resolve(token);
                } else {
                    console.log("b2")
                    resolve(false);
                };
            });

        })

    }



    /*
    * Authenticated and save doc
    */
    async authenticated(session, numero) {
        return new Promise((resolve, reject) => {
            console.log("Connected 2!");

            let query = " INSERT INTO praweb.numero_token SET ? ON DUPLICATE KEY UPDATE extra = ?"

            let values = {
                numero: numero,
                extra: JSON.stringify(session)
            }

            let sql = con.format(query, [values, JSON.stringify(session)]);

            con.query(sql, function (err) {
                if (err) {
                    reject(err)
                }
            });
        });
    };


    /**
     * Sets up events and requirements, kicks off authentication request
     */
    async initialize(numero) {
        try {

            console.log("this.options.puppeteer", this.options.puppeteer)

            const browser = await puppeteer.launch(this.options.puppeteer);
            const page = (await browser.pages())[0];
            page.setUserAgent(UserAgent);

            this.pupBrowser = browser;
            this.pupPage = page;

            let session_number = await this.verifyQrCode(numero);

            console.log("teste")
            if (session_number) {
                console.log("aq1")
                await page.evaluateOnNewDocument(
                    session => {
                        localStorage.clear();
                        localStorage.setItem('WABrowserId', session.WABrowserId);
                        localStorage.setItem('WASecretBundle', session.WASecretBundle);
                        localStorage.setItem('WAToken1', session.WAToken1);
                        localStorage.setItem('WAToken2', session.WAToken2);
                    }, session_number);
            }

            await page.goto(WhatsWebURL, {
                waitUntil: 'load',
                timeout: 0,
            });

            const KEEP_PHONE_CONNECTED_IMG_SELECTOR = '[data-asset-intro-image-light="true"]';

            if (session_number) {
                console.log("aq2")
                // Check if session restore was successfull 
                try {
                    await page.waitForSelector(KEEP_PHONE_CONNECTED_IMG_SELECTOR, { timeout: this.options.authTimeoutMs });
                } catch (err) {
                    if (err.name === 'TimeoutError') {

                        this.failure();
                        browser.close();
                        if (this.options.restartOnAuthFail) {
                            // session restore failed so try again but without session to force new authentication
                            session_number = null;
                            this.initialize();
                        }
                        return;
                    }
                    return false;
                }

            } else {

                const getQrCode = async () => {
                    try {
                        // Check if retry button is present
                        var QR_RETRY_SELECTOR = 'div[data-ref] > span > div';
                        var qrRetry = await page.$(QR_RETRY_SELECTOR);
                        if (qrRetry) {
                            await qrRetry.click();
                        }

                        // Wait for QR Code

                        const QR_CANVAS_SELECTOR = 'canvas';
                        await page.waitForSelector(QR_CANVAS_SELECTOR, { timeout: this.options.qrTimeoutMs });
                        const qrImgData = await page.$eval(QR_CANVAS_SELECTOR, canvas => [].slice.call(canvas.getContext('2d').getImageData(0, 0, 264, 264).data));
                        const qr = jsQR(qrImgData, 264, 264).data;
                    } catch (e) {
                        return false;
                    }
                };
                getQrCode();
                let retryInterval = setInterval(getQrCode, this.options.qrRefreshIntervalMs);

                await page.waitForSelector(KEEP_PHONE_CONNECTED_IMG_SELECTOR, { timeout: 0 });
                clearInterval(retryInterval);

            }

            await page.evaluate(ExposeStore, moduleRaid.toString());

            // Get session tokens
            const localStorage = JSON.parse(await page.evaluate(() => {
                return JSON.stringify(window.localStorage);
            }));

            const session = {
                WABrowserId: localStorage.WABrowserId,
                WASecretBundle: localStorage.WASecretBundle,
                WAToken1: localStorage.WAToken1,
                WAToken2: localStorage.WAToken2
            };


            this.authenticated(session, numero);

            // Check window.Store Injection
            await page.waitForFunction('window.Store != undefined');

            //Load util functions (serializers, helper functions)
            await page.evaluate(LoadUtils);

            // Expose client info
            this.info = new ClientInfo(this, await page.evaluate(() => {
                return window.Store.Conn.serialize();
            }));

            return true;

        } catch (e) {
            console.log("err", e);
            return false;
        }
    }
    /*
    *   Authentication failure
    */
    async failure() {
        // Fired if session restore was unsuccessfull
        console.error('AUTHENTICATION FAILURE');
    };

    /*
    *   QR Received
    */
    async qr(qr) {
        // NOTE: This event will not be fired if a session is specified.
        console.log('QR RECEIVED', qr);
    };

    /**
     * Closes the client
     */
    async destroy() {
        await this.pupBrowser.close();
    }

    /**
     * Returns the version of WhatsApp Web currently being run
     * @returns Promise<string>
     */
    async getWWebVersion() {
        return await this.pupPage.evaluate(() => {
            return window.Debug.VERSION;
        });
    }

    /**
     * Mark as seen for the Chat
     *  @param {string} chatId
     *  @returns {Promise<boolean>} result
     * 
     */
    async sendSeen(chatId) {
        const result = await this.pupPage.evaluate(async (chatId) => {
            return window.WWebJS.sendSeen(chatId);

        }, chatId);
        return result;
    }

    /**
     * Send a message to a specific chatId
     * @param {string} chatId
     * @param {string|MessageMedia|Location} content
     * @param {object} options 
     * @returns {Promise<Message>} Message that was just sent
     */
    async sendMessage(chatId, content, options = {}) {
        try {
            let internalOptions = {
                linkPreview: options.linkPreview === false ? undefined : true,
                sendAudioAsVoice: options.sendAudioAsVoice,
                caption: options.caption,
                quotedMessageId: options.quotedMessageId,
                mentionedJidList: Array.isArray(options.mentions) ? options.mentions.map(contact => contact.id._serialized) : []
            };

            const sendSeen = typeof options.sendSeen === 'undefined' ? true : options.sendSeen;

            if (content instanceof MessageMedia) {
                internalOptions.attachment = content;
                content = '';
            } else if (options.media instanceof MessageMedia) {
                internalOptions.attachment = options.media;
                internalOptions.caption = content;
                content = '';
            } else if (content instanceof Location) {
                internalOptions.location = content;
                content = '';
            }

            const newMessage = await this.pupPage.evaluate(async (chatId, message, options, sendSeen) => {
                const chatWid = window.Store.WidFactory.createWid(chatId);
                const chat = await window.Store.Chat.find(chatWid);

                if (sendSeen) {
                    window.WWebJS.sendSeen(chatId);
                }

                const msg = await window.WWebJS.sendMessage(chat, message, options, sendSeen);
                return msg.serialize();
            }, chatId, content, internalOptions, sendSeen);

            return new Message(this, newMessage);
        } catch (e) {
            return false;
        }

    }

    /**
     * Get all current chat instances
     * @returns {Promise<Array<Chat>>}
     */
    async getChats() {
        let chats = await this.pupPage.evaluate(() => {
            return window.WWebJS.getChats();
        });

        return chats.map(chat => ChatFactory.create(this, chat));
    }

    /**
     * Get chat instance by ID
     * @param {string} chatId 
     * @returns {Promise<Chat>}
     */
    async getChatById(chatId) {
        let chat = await this.pupPage.evaluate(chatId => {
            return window.WWebJS.getChat(chatId);
        }, chatId);

        return ChatFactory.create(this, chat);
    }

    /**
     * Get all current contact instances
     * @returns {Promise<Array<Contact>>}
     */
    async getContacts() {
        let contacts = await this.pupPage.evaluate(() => {
            return window.WWebJS.getContacts();
        });

        return contacts.map(contact => ContactFactory.create(this, contact));
    }

    /**
     * Get contact instance by ID
     * @param {string} contactId
     * @returns {Promise<Contact>}
     */
    async getContactById(contactId) {
        let contact = await this.pupPage.evaluate(contactId => {
            return window.WWebJS.getContact(contactId);
        }, contactId);

        return ContactFactory.create(this, contact);
    }

    /**
     * Accepts an invitation to join a group
     * @param {string} inviteCode Invitation code
     */
    async acceptInvite(inviteCode) {
        const chatId = await this.pupPage.evaluate(async inviteCode => {
            return await window.Store.Invite.sendJoinGroupViaInvite(inviteCode);
        }, inviteCode);

        return chatId._serialized;
    }

    /**
     * Sets the current user's status message
     * @param {string} status New status message
     */
    async setStatus(status) {
        await this.pupPage.evaluate(async status => {
            return await window.Store.Wap.sendSetStatus(status);
        }, status);
    }

    /**
     * Gets the current connection state for the client
     * @returns {WAState} 
     */
    async getState() {
        return await this.pupPage.evaluate(() => {
            return window.Store.AppState.state;
        });
    }

    /**
     * Marks the client as online
     */
    async sendPresenceAvailable() {
        return await this.pupPage.evaluate(() => {
            return window.Store.Wap.sendPresenceAvailable();
        });
    }

    /**
     * Enables and returns the archive state of the Chat
     * @returns {boolean}
     */
    async archiveChat(chatId) {
        return await this.pupPage.evaluate(async chatId => {
            let chat = await window.Store.Chat.get(chatId);
            await window.Store.Cmd.archiveChat(chat, true);
            return chat.archive;
        }, chatId);
    }

    /**
     * Changes and returns the archive state of the Chat
     * @returns {boolean}
     */
    async unarchiveChat(chatId) {
        return await this.pupPage.evaluate(async chatId => {
            let chat = await window.Store.Chat.get(chatId);
            await window.Store.Cmd.archiveChat(chat, false);
            return chat.archive;
        }, chatId);
    }

    /**
     * Mutes the Chat until a specified date
     * @param {string} chatId ID of the chat that will be muted
     * @param {Date} unmuteDate Date when the chat will be unmuted
     */
    async muteChat(chatId, unmuteDate) {
        await this.pupPage.evaluate(async (chatId, timestamp) => {
            let chat = await window.Store.Chat.get(chatId);
            await chat.mute.mute(timestamp, !0);
        }, chatId, unmuteDate.getTime() / 1000);
    }

    /**
     * Unmutes the Chat
     * @param {string} chatId ID of the chat that will be unmuted
     */
    async unmuteChat(chatId) {
        await this.pupPage.evaluate(async chatId => {
            let chat = await window.Store.Chat.get(chatId);
            await window.Store.Cmd.muteChat(chat, false);
        }, chatId);
    }

    /**
     * Returns the contact ID's profile picture URL, if privacy settings allow it
     * @param {string} contactId the whatsapp user's ID
     * @returns {Promise<string>}
     */
    async getProfilePicUrl(contactId) {
        const profilePic = await this.pupPage.evaluate((contactId) => {
            return window.Store.Wap.profilePicFind(contactId);
        }, contactId);

        return profilePic ? profilePic.eurl : undefined;
    }

    /**
     * Force reset of connection state for the client
    */
    async resetState() {
        await this.pupPage.evaluate(() => {
            window.Store.AppState.phoneWatchdog.shiftTimer.forceRunNow();
        });
    }

    /**
     * Check if a given ID is registered in whatsapp
     * @returns {Promise<Boolean>}
     */
    async isRegisteredUser(id) {
        return await this.pupPage.evaluate(async (id) => {
            let result = await window.Store.Wap.queryExist(id);
            return result.jid !== undefined;
        }, id);
    }

    /**
     * Create a new group
     * @param {string} name group title
     * @param {Array<Contact|string>} participants an array of Contacts or contact IDs to add to the group
     * @returns {Object} createRes
     * @returns {string} createRes.gid - ID for the group that was just created
     * @returns {Object.<string,string>} createRes.missingParticipants - participants that were not added to the group. Keys represent the ID for participant that was not added and its value is a status code that represents the reason why participant could not be added. This is usually 403 if the user's privacy settings don't allow you to add them to groups.
     */
    async createGroup(name, participants) {
        if (!Array.isArray(participants) || participants.length == 0) {
            throw 'You need to add at least one other participant to the group';
        }

        if (participants.every(c => c instanceof Contact)) {
            participants = participants.map(c => c.id._serialized);
        }

        const createRes = await this.pupPage.evaluate(async (name, participantIds) => {
            const res = await window.Store.Wap.createGroup(name, participantIds);
            console.log(res);
            if (!res.status === 200) {
                throw 'An error occurred while creating the group!';
            }

            return res;
        }, name, participants);

        const missingParticipants = createRes.participants.reduce(((missing, c) => {
            const id = Object.keys(c)[0];
            const statusCode = c[id].code;
            if (statusCode != 200) return Object.assign(missing, { [id]: statusCode });
            return missing;
        }), {});

        return { gid: createRes.gid, missingParticipants };
    }

}

module.exports = Client;
