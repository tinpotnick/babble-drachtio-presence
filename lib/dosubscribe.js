/*
# dosubscribe.js

This file responds to REGISTER events from our Registrar object. When we have a UAC
register to us, we then SUBSCRIBE to the client to pick up on information

* DND
*/

const digestauth = require( "drachtio-mw-digest-auth" )
const doc = require( "./presencedocument.js" )
const assert = require( "assert" )

const expiresmatch = /expires=(\d*)/
const activematch = /^(active|init)/

let subscribeperregister

function addregsub( reg, dialog ) {
  deleteregsub( reg )
  subscribeperregister.set( reg.uuid, new RegSubscription( reg, dialog ) )
  console.log( `We are subscribed to ${subscribeperregister.size} registered endpoints` )
}

function hasregsub( reg ) {
  return subscribeperregister.has( reg.uuid )
}

function deleteregsub( reg ) {
  if( subscribeperregister.has( reg.uuid ) ) {
    let sub = subscribeperregister.get( reg.uuid )
    sub.cleanup()
  }
}

function refreshregsub( reg ) {
  if( subscribeperregister.has( reg.uuid ) ) {
    let sub = subscribeperregister.get( reg.uuid )

    let opts = {
      "method": "SUBSCRIBE",
      "headers": {
        "Event": "presence",
        "Expires": reg.expiresin,
        "Accept": "application/pidf+xml"
      }
    }

    sub.dialog.request( opts )
      .then( ( res ) => {
        switch( res.msg.status ) {
          case 200:
          case 202:
            sub.refresh()
            break
          default:
            sub.cleanup()
        }
      } )
      .catch( () => {
        sub.cleanup()
      } )
  }

  return false
}

/*
Store dialogs per registeration.
*/
class RegSubscription {
  constructor( reg, dialog ) {
    this.dialog = dialog
    this.reg = reg

    this.timer = setTimeout( () => { this.timer = -1; this.cleanup() }, this.reg.expiresin * 1000 )
  }

  refresh() {
    clearTimeout( this.timer )
    this.timer = setTimeout( () => { this.timer = -1; this.cleanup() }, this.reg.expiresin * 1000 )
  }

  cleanup() {
    if( -1 !== this.timer ) {
      clearTimeout( this.timer )
      this.timer = -1
    }

    subscribeperregister.delete( this.reg.uuid )

    if( this.dialog.connected ) {
      this.dialog.destroy().catch( ()=> {} )
    }

    console.log( `We are subscribed to ${subscribeperregister.size} registered endpoints` )
  }
}

module.exports.unreg = ( options ) => {
  assert( options.em !== undefined )
  if( undefined === subscribeperregister ) subscribeperregister = new Map()

  return ( reg ) => {
    deleteregsub( reg )
  }
}

module.exports.reg = ( options ) => {

  assert( options.em !== undefined )
  if( undefined === subscribeperregister ) subscribeperregister = new Map()

  return ( reg ) => {

    if( !reg.allow.includes( "SUBSCRIBE" ) ) {
      console.error( "Client doesn't allow subscribing - so ignoring" )
      return
    }

    if( hasregsub( reg ) ) {
      /* This is a renewal of the reg so can be used to trigger refresh on sub dialog */
      refreshregsub( reg )
      return
    }

    options.srf.createUAC( reg.contacts[ 0 ], {
      "method": "SUBSCRIBE",
      "headers": {
        "To": `<sip:${reg.authorization.username}@${reg.authorization.realm}>`,
        "From": `<sip:${reg.authorization.username}@${reg.authorization.realm}>`,
        "Event": "presence",
        "Expires": reg.expiresin,
        "Accept": "application/pidf+xml"
      }
    } ).then( ( dialog ) => {

      addregsub( reg, dialog )

      dialog.on( "destroy", () => {
        deleteregsub( reg )
        console.log( "Remote party ended subscribe dialog" )
      } )

      dialog.on( "notify", ( req, res ) => {

        digestauth( {
          "proxy": true, /* 407 or 401 */
          "passwordLookup": ( username, realm, cb ) => {
            options.userlookup( username, realm )
              .then( ( u ) => {
                cb( false, u.secret )
              } )
              .catch( () => {
                cb( false, false )
              } )
          },
          "realm": reg.authorization.realm
        } )( req, res, () => {

          /*
            Should be active and possibly contain ;expires= where 0 expires the subscription.
          */
          let substate = req.get( "Subscription-State" )
          if( null === substate.match( activematch ) ) {
            res.send( 400, "Wrong subscription state" )
            return
          }

          let expires = substate.match( expiresmatch )
          if( null !== expires && expires.length > 1 ) {
            if( "0" == expires[ 1 ] ) {
              deleteregsub( reg )
            }
          }

          if( 0 === parseInt( req.get( "Content-Length" ) ) ) {
            res.send( 200 )
            return
          }

          /* We are now authed */
          let s = doc.parsepidfxml( req.get( "Content-Type" ), req.body )
          if( false === s ) {
            res.send( 400, "Bad request - or at least we don't understand it" )
          } else {

            options.em.emit( "presence.status.in", {
              ...s,
              ...{
                "entity": req.authorization.username + "@" + req.authorization.realm,
                "source": {
                  "event": "NOTIFY",
                  "address": req.source_address,
                  "port": req.source_port,
                  "related": reg.contacts[ 0 ]
                }
              }
            } )

            res.send( 200 )
          }
        } )
      } )
    } ).catch( ( err ) => {
      console.log( `Error with creating client subscription for ${reg.authorization.username}@${reg.authorization.realm}` )
      //console.error( err )
    } )
  }
}
