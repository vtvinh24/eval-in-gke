#!/bin/bash

# Simple test script for the demo judge server

echo "=== Testing Demo Judge Server ==="
echo

# Test server health (assuming it's running on localhost:3000)
echo "1. Testing server health..."
if curl -s http://localhost:3000 > /dev/null; then
    echo "✓ Server is running on http://localhost:3000"
else
    echo "✗ Server is not accessible"
    exit 1
fi

echo

# Test authentication endpoint
echo "2. Testing authentication..."
AUTH_RESPONSE=$(curl -s -X POST http://localhost:3000/api/auth \
    -H "Content-Type: application/json" \
    -d '{"username": "team1", "password": "team123"}')

if echo "$AUTH_RESPONSE" | grep -q "user"; then
    echo "✓ Authentication working"
    echo "   Response: $AUTH_RESPONSE"
else
    echo "✗ Authentication failed"
    echo "   Response: $AUTH_RESPONSE"
fi

echo

# Test submissions endpoint (should require auth)
echo "3. Testing submissions endpoint..."
SUBMISSIONS_RESPONSE=$(curl -s http://localhost:3000/api/submissions)
echo "   Response: $SUBMISSIONS_RESPONSE"

echo

# Test leaderboard endpoint
echo "4. Testing leaderboard endpoint..."
LEADERBOARD_RESPONSE=$(curl -s http://localhost:3000/api/leaderboard)
echo "   Response: $LEADERBOARD_RESPONSE"

echo

echo "=== Test completed ==="
echo "You can now open http://localhost:3000 in your browser to test the UI"
echo
echo "Default credentials:"
echo "Judges: judge1/judge123, judge2/judge123"
echo "Teams: team1/team123, team2/team123, team3/team123"