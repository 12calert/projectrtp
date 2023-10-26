/* if we want to see what is going on - use nodeplotlib instead of our placeholder */
//const npl = require( "nodeplotlib" )
// eslint-disable-next-line no-unused-vars
const npl = { plot: ( /** @type {any} */ a ) => {} }


const fft = require( "fft-js" ).fft
const projectrtp = require( "../../index" ).projectrtp
const expect = require( "chai" ).expect
const dgram = require( "dgram" )
const fs = require( "fs" )


/*
So that we do not have to impliment g722 or other codecs in JS, we create 2 channels, and mix them. 
On one end, we UDP echo back - which means, for example, g722 will be echoed back, then on the other end, 
we generate a signal (tone) and check we receive that signal on the end end.
*/

const datalength = 8192 /* 1 second of data */
const frequency = 400


const magnitude = ( Math.pow( 2, 16 ) / 2 ) - ( 65536 / 4 )

/**
 * Generates time series signal with one sinewave component @ hz
 * @param { number } hz 
 * @returns { Int16Array }
 */
function gensignal( hz ) {

  const y = new Int16Array( datalength )

  for( let i = 0; i < datalength; i ++ ) {
    y[ i ] = Math.sin( i * ( Math.PI * 2 * ( 1 / 8000 ) ) * hz ) * magnitude
  }

  /*
  npl.plot( [ {
    y: Array.from( y ),
    type: "scatter"
  } ] )
  */

  return y
}

/**
 * 
 * @param { Array } arr 
 * @returns 
 */
function truncatetopoweroftwo( arr ) {
  const newsize = Math.pow( 2, Math.floor( Math.log2( arr.length ) ) )
  return arr.slice( 0, newsize )
}

/**
 * 
 * @param { Array< Array< number > > } c - array of complex numbers as returned by fft 
 * @returns { Array< number > }
 */
function amplitude( c ) {
  const out = []

  for( let k = 0; k < c.length; k++ ) {
    const complex = c[ k ]
    const r = complex[ 0 ]
    const i = complex[ 1 ]
    out.push( Math.sqrt( ( r * r ) + ( i * i ) ) )
  }

  return out
}

/**
 * 
 * @param { Array< number > } inarr
 * @param { number } startpos 
 * @param { number } endpos 
 */
function sum( inarr, startpos, endpos ) {
  let oursum = 0
  for( let i = startpos; i < endpos; i++ ) oursum += inarr[ i ]
  return oursum
}

/**
 * 
 * @param { Int16Array } signal 
 * @returns { Array< number > }
 */
function ampbyfrequency( signal ) {
  const pow2signal = truncatetopoweroftwo( Array.from( signal ) )
  const ourfft = fft( pow2signal )
  const amps = amplitude( ourfft )

  /*
  npl.plot( [ {
    y: amps
  } ] )
  */

  return amps
}

/**
 * Checks fft of signal to see if we have a signal at hz present
 * @param { Array< number > } amps
 * @param { number } hz 
 * @param { number } threshold
 */
function has( amps , hz, threshold ) {
  return sum( amps, hz - 20, hz + 20 ) > threshold
}

/**
 * 
 * @param { Array< number > } inarray
 * @returns { Array< number > }
 */
function lineartopcma( inarray ) {
  const out = []
  for( let i = 0; i < inarray.length; i++ )
    out.push( projectrtp.codecx.linear162pcma( inarray[ i ] ) )
  return out
}

/**
 * 
 * @param { Array< number > } inarray
 * @returns { Int16Array }
 */
function pcmatolinear( inarray ) {
  const out = new Int16Array( inarray.length )
  for( let i = 0; i < inarray.length; i++ ) {
    out[ i ] = projectrtp.codecx.pcma2linear16( inarray[ i ] )
  }

  return out
}

/**
 * 
 * @param { Array< number > } inarray
 * @returns { Array< number > }
 */
function lineartopcmu( inarray ) {
  const out = []
  for( let i = 0; i < inarray.length; i++ )
    out.push( projectrtp.codecx.linear162pcmu( inarray[ i ] ) )
  return out
}

/**
 * 
 * @param { Array< number > } inarray
 * @returns { Int16Array }
 */
function pcmutolinear( inarray ) {
  const out = new Int16Array( inarray.length )
  for( let i = 0; i < inarray.length; i++ ) {
    out[ i ] = projectrtp.codecx.pcmu2linear16( inarray[ i ] )
  }

  return out
}

/**
 * 
 * @param { number } sn - should start from 0 which we use to index into the supplied data buffer
 * @param { number } dstport 
 * @param { object } server 
 * @param { number } pt - payload type
 * @param { number } ssrc  - a unique payload type
 * @param { Array< number > } payload
 * @param { number } [ snoffset = 0 ] - if we want to have an offset
 * @returns 
 */
function sendpk( sn, dstport, server, pt = 0, ssrc, payload, snoffset=0 ) {

  if( !ssrc ) ssrc = 25
  const ts = sn * 160
  const sendtime = sn * 20

  const uint8pl = new Uint8Array( payload.slice( sn , sn + 160 ) )

  return setTimeout( () => {
    const subheader = Buffer.alloc( 10 )

    subheader.writeUInt16BE( ( sn + snoffset ) % ( 2**16 ) )
    subheader.writeUInt32BE( ts, 2 )
    subheader.writeUInt32BE( ssrc, 6 )

    const rtppacket = Buffer.concat( [
      Buffer.from( [ 0x80, pt ] ),
      subheader,
      uint8pl ] )

    server.send( rtppacket, dstport, "localhost" )
  }, sendtime )
}

/**
 * Limitation of not parsing ccrc.
 * @param { Buffer } packet
 * @return { object }
 */
function parsepk( packet ) {
  return {
    sn: packet.readUInt16BE( 2 ),
    ts: packet.readUInt32BE( 4 ),
    pt: packet.readUInt8( 1 ) & 0x7f,
    ssrc: packet.readUInt32BE( 8 ),
    payload: new Uint8Array( packet.slice( 12 ) )
  }
}

/**
 * @callback encodefunction
 * @param { Array< number > } inarray
 * @returns { Array< number > }
 */

/**
 * @callback decodefunction
 * @param { Array< number > } inarray
 * @returns { Int16Array }
 */

/**
 * Run a loop test: generate signal - endcode pass to a channel, mix with second channal
 * receive this rtp and loop back and finally recieve and test for signal in sound.
 * This tests the full audio loop with codec conversion.
 * The encode and decode functions must match the bcodec, i.e. bcodec tells 
 * projectrtp what codec to accept on that channel, the functions are what takes
 * our linear16 and encodes and decodes into the payload.
 * @param { number } acodec 
 * @param { number } bcodec 
 * @param { encodefunction } encode 
 * @param { decodefunction } decode 
 */
async function looptest( acodec, bcodec, encode, decode ) {
  const a = dgram.createSocket( "udp4" )
  const b = dgram.createSocket( "udp4" )

  a.bind()
  await new Promise( resolve => a.on( "listening", resolve ) )
  b.bind()
  await new Promise( resolve => b.on( "listening", resolve ) )

  let done
  const finished = new Promise( ( r ) => { done = r } )

  const achannel = await projectrtp.openchannel( { "id": "4", "remote": { "address": "localhost", "port": a.address().port, "codec": acodec } }, function( d ) {
    if( "close" === d.action ) {
      a.close()
      b.close()
      bchannel.close()
    }
  } )

  const bchannel = await projectrtp.openchannel( { "id": "4", "remote": { "address": "localhost", "port": b.address().port, "codec": bcodec } }, function( d ) {
    if( "close" === d.action ) done()
  } )

  bchannel.mix( achannel )

  /* echo straight back */
  a.on( "message", function( msg ) {
    a.send( msg, achannel.local.port, "localhost" )
  } )

  let received = Buffer.alloc( 0 )
  let ondonereceiving, recvcount = 0
  const receiveuntil = new Promise( resolve => ondonereceiving = resolve )
  b.on( "message", function( msg ) {
    const pk = parsepk( msg )
    received = Buffer.concat( [ received, pk.payload ] )
    if( 50 < recvcount++ ) ondonereceiving()
  } )

  const y = gensignal( frequency )
  const encoded = encode( Array.from( y ) )

  for( let i = 0; 60 > i; i ++ ) {
    sendpk( i, bchannel.local.port, b, bcodec, 44, encoded )
  }

  await receiveuntil
  const y2 = decode( Array.from( received ) )

  achannel.close()
  await finished

  npl.plot( [ {
    y: Array.from( y ),
    type: "scatter"
  } ] )

  npl.plot( [ {
    y: Array.from( y2 ),
    type: "scatter"
  } ] )

  const amps = ampbyfrequency( y2 )
  expect( has( amps, frequency - 100, 25000000 ) ).to.be.false
  expect( has( amps, frequency, 25000000 ) ).to.be.true
  expect( has( amps, frequency + 100, 25000000 ) ).to.be.false
}


describe( "Transcode", function() {

  this.slow( 3000 )
  this.timeout( 5000 )

  it( "Test our linear to pcma converting routines", async function() {

    const y = gensignal( frequency )

    const pcma = lineartopcma( Array.from( y ) )
    const y2 = pcmatolinear( pcma )

    npl.plot( [ {
      y: y2,
      type: "scatter"
    } ] )

    const amps = ampbyfrequency( y )
    expect( has( amps, 300, 25000000 ) ).to.be.false
    expect( has( amps, 400, 25000000 ) ).to.be.true
    expect( has( amps, 500, 25000000 ) ).to.be.false
  } )

  it( "trancode pcmu <==> ilbc", async function() {
    await looptest( 97, 0, lineartopcmu, pcmutolinear )
  } )

  it( "trancode pcmu <==> g722", async function() {
    await looptest( 9, 0, lineartopcmu, pcmutolinear )
  } )

  it( "trancode pcmu <==> pcma", async function() {
    await looptest( 8, 0, lineartopcmu, pcmutolinear )
  } )

  it( "trancode pcma <==> ilbc", async function() {
    await looptest( 97, 8, lineartopcma, pcmatolinear )
  } )

  it( "trancode pcma <==> g722", async function() {
    await looptest( 9, 8, lineartopcma, pcmatolinear )
  } )

  it( "trancode pcma <==> pcmu", async function() {
    await looptest( 0, 8, lineartopcma, pcmatolinear )
  } )

  it( "simulate an xfer with multiple mix then test new path pcma <==> g722", async function() {

    this.timeout( 8000 )
    this.slow( 7000 )

    /* make sure we have some tone to play */
    projectrtp.tone.generate( "300*0.5:2000", "/tmp/tone.wav" )
    projectrtp.tone.generate( "800*0.5:2000", "/tmp/hightone.wav" )

    /**
     * a and b is the 2 phone legs, c is the transfered channel
     */
    const acodec = 8
    const bcodec = 0
    const ccodec = 9

    /*
    a = 8, b = 0, c = 0 missing tones on a
    a = 8, b = 9, c = 0 all works
    a = 8, b = 0, c = 9, missing tones and missing c leg back on a
    */

    const a = dgram.createSocket( "udp4" )
    const b = dgram.createSocket( "udp4" )
    const c = dgram.createSocket( "udp4" )

    a.bind()
    await new Promise( resolve => a.on( "listening", resolve ) )
    b.bind()
    await new Promise( resolve => b.on( "listening", resolve ) )
    c.bind()
    await new Promise( resolve => c.on( "listening", resolve ) )

    /* echo straight back */
    c.on( "message", function( msg ) {
      c.send( msg, cchannel.local.port, "localhost" )
    } )

    b.on( "message", function( msg ) {
      b.send( msg, bchannel.local.port, "localhost" )
    } )

    let received = Buffer.alloc( 0 )
    let ondonereceiving, recvcount = 0
    const receiveuntil = new Promise( resolve => ondonereceiving = resolve )
    a.on( "message", function( msg ) {
      const pk = parsepk( msg )
      received = Buffer.concat( [ received, pk.payload ] )
      if( 100 < recvcount++ ) ondonereceiving()
    } )

    let done
    const finished = new Promise( ( resolve ) => { done = resolve } )

    let unmixresolve
    const unmixdone = new Promise( resolve => unmixresolve = resolve )

    /* This channel reflects the outbound channel */
    const achannel = await projectrtp.openchannel( { "id": "4" }, function( d ) {
      if( "close" === d.action ) {
        a.close()
        b.close()
        c.close()
        cchannel.close()
      }

      if( "mix" === d.action && "finished" === d.event ) unmixresolve()
    } )

    await new Promise( resolve => setTimeout( resolve, 800 ) )
    achannel.remote( { "address": "localhost", "port": a.address().port, "codec": acodec } )

    /* This channel reflects the originator */
    const bchannel = await projectrtp.openchannel( { "id": "5", "remote": { "address": "localhost", "port": b.address().port, "codec": bcodec } }, function( /*d*/ ) {
    } )

    achannel.mix( bchannel )
    await new Promise( resolve => setTimeout( resolve, 500 ) ) // we really should wait for the mix start events

    /* for some reason in our lib this gets sent again */
    achannel.remote( { "address": "localhost", "port": a.address().port, "codec": acodec } )
    bchannel.remote( { "address": "localhost", "port": b.address().port, "codec": bcodec } )

    achannel.mix( bchannel )
    bchannel.record( { file: "/tmp/test.wav", numchannels: 2, mp3: true } )

    const y = gensignal( 100 )
    const encoded = lineartopcma( Array.from( y ) )

    for( let i = 0 ; 120 > i; i ++ ) {
      sendpk( i, achannel.local.port, a, acodec, 44, encoded, 6300 )
    }

    await new Promise( resolve => setTimeout( resolve, 1200 ) )

    /* Now our blind xfer happens */
    achannel.unmix()
    bchannel.unmix()
    await unmixdone
    
    /* moh followed by ringing tone */
    achannel.play( { "loop": true, "files": [ { "wav": "/tmp/tone.wav" } ] } )
    await new Promise( resolve => setTimeout( resolve, 200 ) )
    achannel.play( { "loop": true, "files": [ { "wav": "/tmp/hightone.wav" } ] } )

    await new Promise( resolve => setTimeout( resolve, 200 ) )

    /* now open our new leg */
    const cchannel = await projectrtp.openchannel( { "id": "6" }, function( d ) {
      if( "close" === d.action ) done()
    } )

    bchannel.close()
    cchannel.remote( { "address": "localhost", "port": c.address().port, "codec": ccodec } )
    await new Promise( resolve => setTimeout( resolve, 40 ) )
    cchannel.mix( achannel )

    /* now we have one way audio in real life */
    await receiveuntil
    const y2 = pcmatolinear( Array.from( received ) )

    await new Promise( resolve => setTimeout( resolve, 1000 ) )
    achannel.close()
    await finished

    npl.plot( [ {
      y: Array.from( y ),
      type: "scatter"
    } ] )

    npl.plot( [ {
      y: Array.from( y2 ),
      type: "scatter"
    } ] )

    /* TODO this currently doesn't test the c leg as this is teh same frequency as the a leg*/
    const amps = ampbyfrequency( y2 )
    expect( has( amps, 100, 25000000 ) ).to.be.true
    expect( has( amps, 300, 25000000 ) ).to.be.true
    expect( has( amps, 800, 25000000 ) ).to.be.true
    expect( has( amps, 500, 25000000 ) ).to.be.false

    await fs.promises.unlink( "/tmp/ukringing.wav" ).catch( () => {} )
  } )
} )

