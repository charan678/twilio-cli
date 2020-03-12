const os = require('os');
const { flags } = require('@oclif/command');

const { BaseCommand, TwilioClientCommand } = require('@twilio/cli-core').baseCommands;
const { CliRequestClient } = require('@twilio/cli-core').services;
const { TwilioCliError } = require('@twilio/cli-core').services.error;
const { STORAGE_LOCATIONS } = require('@twilio/cli-core').services.secureStorage;

const helpMessages = require('../../services/messaging/help-messages');

const FRIENDLY_STORAGE_LOCATIONS = {
  [STORAGE_LOCATIONS.KEYCHAIN]: 'in your keychain',
  [STORAGE_LOCATIONS.WIN_CRED_VAULT]: 'in the Windows credential vault',
  [STORAGE_LOCATIONS.LIBSECRET]: 'using libsecret'
};

const SKIP_VALIDATION = 'skip-parameter-validation';

class ProfilesCreate extends BaseCommand {
  constructor(argv, config, secureStorage) {
    super(argv, config, secureStorage);

    this.accountSid = undefined;
    this.authToken = undefined;
    this.profileId = undefined;
    this.force = false;
    this.questions = [];
  }

  async run() {
    await super.run();

    // Eagerly load up the credential store. No need to proceed if this fails.
    await this.secureStorage.loadKeytar();

    this.loadArguments();

    this.loadAccountSid();
    this.loadAuthToken();
    await this.promptForCredentials();

    if (await this.validateCredentials()) {
      await this.loadProfileId();
      await this.saveCredentials();
      this.logger.info(`Saved ${this.profileId}.`);
    } else {
      this.cancel();
    }
  }

  loadArguments() {
    this.force = this.flags.force;
    this.region = this.flags.region;
  }

  async loadProfileId() {
    this.profileId = this.flags.profile;
    if (!this.profileId) {
      const answer = await this.inquirer.prompt([
        {
          name: 'profileId',
          message: this.getPromptMessage(ProfilesCreate.flags.profile.description),
          validate: input => Boolean(input.trim())
        }
      ]);
      this.profileId = answer.profileId;
    }

    this.profileId = this.profileId.trim();

    if (!(await this.confirmProfileAndEnvVars()) || !(await this.confirmOverwrite())) {
      this.cancel();
    }
  }

  loadAccountSid() {
    this.accountSid = this.args['account-sid'];
    if (!this.accountSid) {
      this.questions.push({
        name: 'accountSid',
        message: this.getPromptMessage(ProfilesCreate.args[0].description),
        validate: input => this.validAccountSid(input)
      });
    }
  }

  loadAuthToken() {
    this.authToken = this.flags['auth-token'];
    if (!this.authToken) {
      this.questions.push({
        type: 'password',
        name: 'authToken',
        message: this.getPromptMessage(ProfilesCreate.flags['auth-token'].description),
        validate: input => this.validAuthToken(input)
      });
    }
  }

  validAccountSid(input) {
    if (!input) {
      return false;
    }

    if (!this.flags[SKIP_VALIDATION]) {
      if (!input.startsWith('AC') || input.length !== 34) {
        return 'Account SID must be "AC" followed by 32 hexadecimal digits (0-9, a-z)';
      }
    }

    return true;
  }

  validAuthToken(input) {
    if (!input) {
      return false;
    }

    if (!this.flags[SKIP_VALIDATION]) {
      if (input.length !== 32) {
        return 'Auth Token must be 32 characters in length';
      }
    }

    return true;
  }

  async promptForCredentials() {
    if (this.questions && this.questions.length > 0) {
      this.logger.info(helpMessages.WHERE_TO_FIND_ACCOUNT_SID);
      this.logger.error(helpMessages.AUTH_TOKEN_NOT_SAVED);
      const answers = await this.inquirer.prompt(this.questions);
      this.accountSid = answers.accountSid || this.accountSid;
      this.authToken = answers.authToken || this.authToken;
    }

    const throwIfInvalid = valid => {
      if (valid !== true) {
        throw new TwilioCliError(valid || 'You must provide a valid value');
      }
    };

    throwIfInvalid(this.validAccountSid(this.accountSid));
    throwIfInvalid(this.validAuthToken(this.authToken));
  }

  async confirmOverwrite() {
    let overwrite = true;
    if (this.userConfig.getProfileById(this.profileId)) {
      overwrite = this.force;
      if (!overwrite) {
        const confirm = await this.inquirer.prompt([
          {
            type: 'confirm',
            name: 'overwrite',
            message: `Overwrite existing profile credentials for "${this.profileId}"?`,
            default: false
          }
        ]);
        overwrite = confirm.overwrite;
      }
    }
    return overwrite;
  }

  async confirmProfileAndEnvVars() {
    let affirmative = true;
    if (this.userConfig.getProfileFromEnvironment()) {
      const confirm = await this.inquirer.prompt([
        {
          type: 'confirm',
          name: 'affirmative',
          message:
            'Account credentials are currently stored in environment variables and will take precedence over ' +
            `the "${this.profileId}" profile when connecting to Twilio, unless the "${this.profileId}" profile is ` +
            `explicitly specified. Continue setting up "${this.profileId}" profile?`,
          default: false
        }
      ]);
      affirmative = confirm.affirmative;
    }
    return affirmative;
  }

  cancel() {
    this.logger.warn('Cancelled');
    this.exit(1);
  }

  getTwilioClient() {
    if (!this.twilioClient) {
      this.twilioClient = require('twilio')(this.accountSid, this.authToken, {
        httpClient: new CliRequestClient(this.id, this.logger),
        region: this.region
      });
    }
    return this.twilioClient;
  }

  async validateCredentials() {
    const twilioClient = this.getTwilioClient();
    try {
      // Don't log the response since it contains the account auth token.
      await twilioClient.api.accounts(this.accountSid).fetch();
      return true;
    } catch (error) {
      this.logger.error('Could not validate the provided credentials. Not saving.');
      this.logger.debug(error);
      return false;
    }
  }

  getApiKeyFriendlyName() {
    const username = this.getUsername();
    const friendlyName = `twilio-cli${username ? ' for ' + username : ''} on ${os.hostname()}`;
    return friendlyName.substring(0, 64);
  }

  getUsername() {
    try {
      return os.userInfo().username;
    } catch (error) {
      // Throws a SystemError if a user has no username or homedir.
      this.logger.debug(error);
    }
  }

  async saveCredentials() {
    const apiKeyFriendlyName = this.getApiKeyFriendlyName();
    let apiKey = null;

    const twilioClient = this.getTwilioClient();
    try {
      apiKey = await twilioClient.newKeys.create({ friendlyName: apiKeyFriendlyName });
      this.logger.debug(apiKey);
    } catch (error) {
      this.logger.debug(error);
      throw new TwilioCliError('Could not create an API Key.');
    }

    this.userConfig.addProfile(this.profileId, this.accountSid, this.region);
    await this.secureStorage.saveCredentials(this.profileId, apiKey.sid, apiKey.secret);
    const configSavedMessage = await this.configFile.save(this.userConfig);

    this.logger.info(
      `Created API Key ${apiKey.sid} and stored the secret ${
        FRIENDLY_STORAGE_LOCATIONS[this.secureStorage.storageLocation]
      }. See: https://www.twilio.com/console/runtime/api-keys/${apiKey.sid}`
    );
    this.logger.info(configSavedMessage);
  }
}

ProfilesCreate.aliases = ['profiles:add', 'login'];
ProfilesCreate.description = 'create a new profile to store Twilio Account credentials and configuration';

ProfilesCreate.flags = Object.assign(
  {
    'auth-token': flags.string({
      description: 'Your Twilio Auth Token for your Twilio Account or Subaccount.'
    }),
    force: flags.boolean({
      char: 'f',
      description: 'Force overwriting existing profile credentials.'
    }),
    [SKIP_VALIDATION]: flags.boolean({
      default: false,
      hidden: true
    }),
    region: flags.string({
      hidden: true
    })
  },
  TwilioClientCommand.flags // Yes! We _do_ want the same flags as TwilioClientCommand
);

ProfilesCreate.args = [
  {
    name: 'account-sid',
    description: 'The Account SID for your Twilio Account or Subaccount.'
  }
];

module.exports = ProfilesCreate;
