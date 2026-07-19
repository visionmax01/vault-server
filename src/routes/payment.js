const express = require('express');
const router = express.Router();
const auth = require('../middlewares/auth');
const User = require('../models/User');

// Plan configuration storage limits in bytes
const PLAN_LIMITS = {
  free: 3 * 1024 * 1024 * 1024,      // 3 GB
  silver: 20 * 1024 * 1024 * 1024,    // 20 GB
  gold: 50 * 1024 * 1024 * 1024,      // 50 GB
  platinum: 100 * 1024 * 1024 * 1024  // 100 GB
};

// Lazy Stripe Client Initializer (prevents app crash if credentials are not set on start)
let stripeInstance = null;
const getStripe = () => {
  if (!stripeInstance) {
    const key = process.env.STRIPE_SECRET_KEY;
    if (!key || key.startsWith('sk_test_...')) {
      throw new Error('Stripe API Key is not configured. Please set a valid STRIPE_SECRET_KEY in your .env file.');
    }
    stripeInstance = require('stripe')(key);
  }
  return stripeInstance;
};

// Create Stripe Checkout Session
router.post('/checkout-session', auth, async (req, res) => {
  const { plan, billing } = req.body;
  
  if (!['silver', 'gold', 'platinum'].includes(plan)) {
    return res.status(400).json({ message: 'Invalid subscription plan selected' });
  }
  
  if (!['monthly', 'yearly'].includes(billing)) {
    return res.status(400).json({ message: 'Invalid billing cycle selected' });
  }

  // Get price ID and API Key from environment variables
  const envKey = `STRIPE_PRICE_${plan.toUpperCase()}_${billing.toUpperCase()}`;
  const priceId = process.env[envKey];
  const key = process.env.STRIPE_SECRET_KEY;

  const isStripeConfigured = key && 
                             !key.startsWith('sk_test_...') && 
                             priceId && 
                             /^price_1[a-zA-Z0-9]+$/.test(priceId);

  // Mock Payment Bypass (For testing end-to-end without Stripe credentials set up)
  if (!isStripeConfigured) {
    if (process.env.ALLOW_MOCK_PAYMENTS === 'true') {
      try {
        console.warn(`[Stripe Mock Mode] Bypassing payment for user ${req.user.id}. Upgrading to ${plan} (${billing})`);
        
        const expiresAt = new Date();
        expiresAt.setMonth(expiresAt.getMonth() + (billing === 'yearly' ? 12 : 1));
        
        await User.findByIdAndUpdate(req.user.id, {
          'subscription.plan': plan,
          'subscription.billing': billing,
          'subscription.expiresAt': expiresAt,
          stripeSubscriptionId: 'mock_sub_id',
          storageLimit: PLAN_LIMITS[plan]
        });
        
        const clientUrl = process.env.CLIENT_URL || 'http://localhost:3000';
        return res.json({ url: `${clientUrl}/settings?checkout=success` });
      } catch (dbErr) {
        return res.status(500).json({ message: 'Mock payment DB update failed: ' + dbErr.message });
      }
    }
    
    return res.status(500).json({ 
      message: `Stripe Price ID not configured on the server. Please set ${envKey} in your .env file, or set ALLOW_MOCK_PAYMENTS=true in your server .env file to enable instant bypass testing.` 
    });
  }

  try {
    const stripe = getStripe();
    const user = await User.findById(req.user.id);
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    // Check or create customer
    let stripeCustomerId = user.stripeCustomerId;
    if (!stripeCustomerId) {
      const customer = await stripe.customers.create({
        email: user.email,
        name: user.name,
        metadata: { userId: user._id.toString() }
      });
      stripeCustomerId = customer.id;
      user.stripeCustomerId = stripeCustomerId;
      await user.save();
    }

    const clientUrl = process.env.CLIENT_URL || 'http://localhost:3000';
    
    // Create checkout session
    const session = await stripe.checkout.sessions.create({
      customer: stripeCustomerId,
      payment_method_types: ['card'],
      line_items: [{ price: priceId, quantity: 1 }],
      mode: 'subscription',
      success_url: `${clientUrl}/settings?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${clientUrl}/settings?checkout=canceled`,
      metadata: {
        userId: user._id.toString(),
        plan,
        billing
      }
    });

    res.json({ url: session.url });
  } catch (error) {
    console.error('Stripe Checkout Error:', error);
    res.status(500).json({ message: error.message || 'Failed to initiate Stripe checkout' });
  }
});

// Create Billing Portal Session
router.post('/portal-session', auth, async (req, res) => {
  try {
    const key = process.env.STRIPE_SECRET_KEY;
    const isStripeConfigured = key && !key.startsWith('sk_test_...');

    // Mock bypass for portal session
    if (!isStripeConfigured && process.env.ALLOW_MOCK_PAYMENTS === 'true') {
      console.warn(`[Stripe Mock Mode] Bypassing billing portal redirect.`);
      const clientUrl = process.env.CLIENT_URL || 'http://localhost:3000';
      return res.json({ url: `${clientUrl}/settings` });
    }

    const stripe = getStripe();
    const user = await User.findById(req.user.id);
    if (!user || !user.stripeCustomerId) {
      return res.status(400).json({ message: 'No active billing profile found for this user.' });
    }

    const clientUrl = process.env.CLIENT_URL || 'http://localhost:3000';
    
    const session = await stripe.billingPortal.sessions.create({
      customer: user.stripeCustomerId,
      return_url: `${clientUrl}/settings`
    });

    res.json({ url: session.url });
  } catch (error) {
    console.error('Stripe Portal Error:', error);
    res.status(500).json({ message: error.message || 'Failed to open billing portal' });
  }
});

// Stripe Webhook Endpoint (Uses rawBody parsed via custom middleware configuration)
router.post('/webhook', async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  
  try {
    const stripe = getStripe();
    const rawBody = req.rawBody || req.body;
    if (webhookSecret && sig && !webhookSecret.startsWith('whsec_...')) {
      event = stripe.webhooks.constructEvent(rawBody, sig, webhookSecret);
    } else {
      // In development mode (if signature / secret is not set or is placeholder)
      event = typeof rawBody === 'string' || Buffer.isBuffer(rawBody) ? JSON.parse(rawBody.toString()) : req.body;
    }
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    const stripe = getStripe();
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;
        const userId = session.metadata.userId;
        const plan = session.metadata.plan;
        const billing = session.metadata.billing;
        const subscriptionId = session.subscription;

        if (userId && plan && billing) {
          const expiresAt = new Date();
          expiresAt.setMonth(expiresAt.getMonth() + (billing === 'yearly' ? 12 : 1));
          
          await User.findByIdAndUpdate(userId, {
            'subscription.plan': plan,
            'subscription.billing': billing,
            'subscription.expiresAt': expiresAt,
            stripeSubscriptionId: subscriptionId,
            storageLimit: PLAN_LIMITS[plan]
          });
          console.log(`[Webhook] User ${userId} successfully upgraded to ${plan} (${billing})`);
        }
        break;
      }
      
      case 'invoice.payment_succeeded': {
        const invoice = event.data.object;
        if (invoice.subscription && invoice.billing_reason === 'subscription_cycle') {
          const subscription = await stripe.subscriptions.retrieve(invoice.subscription);
          const expiresAt = new Date(subscription.current_period_end * 1000);
          
          const user = await User.findOneAndUpdate(
            { stripeSubscriptionId: invoice.subscription },
            { 'subscription.expiresAt': expiresAt }
          );
          if (user) {
            console.log(`[Webhook] Refreshed subscription expiration for user ${user._id} to ${expiresAt}`);
          }
        }
        break;
      }
      
      case 'customer.subscription.deleted': {
        const subscription = event.data.object;
        const user = await User.findOneAndUpdate(
          { stripeSubscriptionId: subscription.id },
          {
            'subscription.plan': 'free',
            'subscription.billing': 'none',
            'subscription.expiresAt': null,
            stripeSubscriptionId: null,
            storageLimit: PLAN_LIMITS['free']
          }
        );
        if (user) {
          console.log(`[Webhook] User ${user._id} subscription was canceled, downgraded to free tier.`);
        }
        break;
      }
      
      case 'customer.subscription.updated': {
        const subscription = event.data.object;
        if (subscription.status === 'active') {
          const expiresAt = new Date(subscription.current_period_end * 1000);
          const priceId = subscription.items.data[0].price.id;
          
          let plan = 'free';
          let billing = 'none';
          
          for (const p of ['silver', 'gold', 'platinum']) {
            for (const b of ['monthly', 'yearly']) {
              const envKey = `STRIPE_PRICE_${p.toUpperCase()}_${b.toUpperCase()}`;
              if (process.env[envKey] === priceId) {
                plan = p;
                billing = b;
              }
            }
          }

          if (plan !== 'free') {
            await User.findOneAndUpdate(
              { stripeSubscriptionId: subscription.id },
              {
                'subscription.plan': plan,
                'subscription.billing': billing,
                'subscription.expiresAt': expiresAt,
                storageLimit: PLAN_LIMITS[plan]
              }
            );
            console.log(`[Webhook] User subscription updated: plan = ${plan}, billing = ${billing}`);
          }
        }
        break;
      }
      
      default:
        console.log(`[Webhook] Unhandled event type: ${event.type}`);
    }
    
    res.json({ received: true });
  } catch (error) {
    console.error('Webhook Handler Error:', error);
    res.status(500).json({ message: 'Internal server error processing webhook event' });
  }
});

module.exports = router;
