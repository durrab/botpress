import jwt from 'jsonwebtoken'
import _ from 'lodash'

import Authentication from '+/authentication'

/**
 * Security helper for botpress
 *
 * Constructor of following functions
 *
 *   - login(user, password, ip)
 *   - authenticate(token)
 *   - getSecret()
 *
 * It will find or create a secret.key in `dataLocation`, then setup the adminPassword for user login.
 *
 */

module.exports = async ({ dataLocation, projectLocation, securityConfig, db, cloud }) => {
  const authentication = Authentication({ dataLocation, securityConfig, db })

  const { tokenExpiry, enabled: loginEnabled, useCloud } = securityConfig
  const isCloudPaired = useCloud && (await cloud.isPaired())
  const { botId } = (isCloudPaired && cloud.getPairingInfo()) || {}

  const buildToken = async loginUser => {
    const secret = await authentication.getSecret()
    return jwt.sign({ user: loginUser }, secret, { issuer: 'bot.root', expiresIn: tokenExpiry, algorithm: 'HS256' })
  }

  // login function that returns a {success, reason, token} object
  // accounts for number of bad attempts
  const login = async (user, password, ip = 'all') => {
    if (isCloudPaired) {
      return { success: false, reason: 'Root authentication is disabled when using Botpress Cloud [BPCLOUDERR]' }
    }

    const canAttempt = await authentication.attempt(ip)
    if (!canAttempt) {
      return { success: false, reason: 'Too many login attempts. Try again later.' }
    }

    const loginUser = await authentication.authenticate(user, password, ip)

    if (loginUser) {
      return {
        success: true,
        token: await buildToken(loginUser)
      }
    } else {
      return {
        success: false,
        reason: 'Bad username / password'
      }
    }
  }

  const getAuthenticationInfo = () => ({
    isCloudPaired,
    botId,
    loginEnabled,
    useCloud,
    botEnv: cloud.getBotEnv(),
    cloudEndpoint: isCloudPaired && cloud.getCloudEndpoint()
  })

  const authenticateWithError = async authHeader => {
    const [scheme, token] = authHeader.split(' ')

    if (scheme !== 'Bearer') {
      // only support Bearer scheme
      throw new Error(`Wrong scheme ${scheme}, expected Bearer`)
    }
    try {
      let secret = null
      let algorithm = null

      if (isCloudPaired) {
        secret = await cloud.getCertificate()
        algorithm = 'RS256'
      } else {
        secret = await authentication.getSecret()
        algorithm = 'HS256'
      }

      const decoded = jwt.verify(token, secret, { algorithms: [algorithm] })
      const verified = authentication.verifyUser ? await authentication.verifyUser(decoded) : true

      if (decoded.identity_proof_only) {
        return false
      }

      if (decoded.aud !== `urn:bot/${botId}`) {
        return false
      }

      return verified && decoded.user
    } catch (err) {
      throw new Error(`The token is invalid or expired`)
    }
  }

  /**
   * @param {string} token
   * @return {boolean} whether the token is valid
   */
  const authenticate = async authHeader => {
    try {
      const user = await authenticateWithError(authHeader)
      return user
    } catch (err) {
      return false
    }
  }

  const getUserIdentity = async token => {
    let secret = null
    let algorithm = null

    if (isCloudPaired) {
      secret = await cloud.getCertificate()
      algorithm = 'RS256'
    } else {
      secret = await authentication.getSecret()
      algorithm = 'HS256'
    }

    const decoded = jwt.verify(token, secret, { algorithms: [algorithm] })
    const verified = authentication.verifyUser ? await authentication.verifyUser(decoded) : true

    if (decoded.aud !== `urn:bot/${botId}`) {
      return false
    }

    return verified && decoded.user
  }

  const refreshToken = async authHeader => {
    if (!loginEnabled) {
      const [scheme, token] = authHeader.split(' ')
      if (scheme !== 'Bearer') {
        // only support Bearer scheme
        return {
          success: false,
          reason: `Wrong scheme ${scheme}, expected Bearer`
        }
      }
      // doesn't matter, can return the same token
      return {
        success: true,
        token
      }
    }

    try {
      const loginUser = await authenticateWithError(authHeader)
      return {
        success: true,
        token: await buildToken(loginUser)
      }
    } catch (err) {
      return {
        success: false,
        reason: err.message || 'The token is invalid or expired'
      }
    }
  }

  return {
    login,
    refreshToken,
    authenticate,
    getUserIdentity,
    getAuthenticationInfo,
    getSecret: authentication.getSecret,
    _authentication: authentication
  }
}
