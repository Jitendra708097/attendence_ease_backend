module.exports = {
  async up(queryInterface, Sequelize) {
    // Create payment_records table
    await queryInterface.createTable('payment_records', {
      id: {
        type: Sequelize.UUID,
        defaultValue: Sequelize.UUIDV4,
        primaryKey: true,
      },
      org_id: {
        type: Sequelize.UUID,
        allowNull: false,
        references: {
          model: 'organisations',
          key: 'id',
        },
        onDelete: 'CASCADE',
      },
      invoice_id: {
        type: Sequelize.STRING(255),
        allowNull: false,
      },
      razorpay_order_id: {
        type: Sequelize.STRING(255),
        allowNull: false,
      },
      razorpay_payment_id: {
        type: Sequelize.STRING(255),
        allowNull: false,
        unique: true,
      },
      razorpay_signature: {
        type: Sequelize.STRING(255),
        allowNull: false,
      },
      amount_paise: {
        type: Sequelize.INTEGER,
        allowNull: false,
      },
      currency: {
        type: Sequelize.STRING(3),
        defaultValue: 'INR',
      },
      status: {
        type: Sequelize.ENUM('pending', 'verified', 'failed'),
        defaultValue: 'verified',
      },
      error_code: {
        type: Sequelize.STRING(50),
      },
      error_message: {
        type: Sequelize.TEXT,
      },
      idempotency_key: {
        type: Sequelize.STRING(255),
        unique: true,
      },
      created_at: {
        type: Sequelize.DATE,
        defaultValue: Sequelize.NOW,
      },
      updated_at: {
        type: Sequelize.DATE,
        defaultValue: Sequelize.NOW,
      },
    });

    // Create composite unique index for org + invoice
    await queryInterface.addConstraint('payment_records', {
      fields: ['org_id', 'invoice_id'],
      type: 'unique',
      name: 'payment_records_org_invoice_unique',
    });

    // Create indexes for query performance
    await queryInterface.addIndex('payment_records', ['org_id', 'created_at'], {
      name: 'idx_payment_records_org_created',
    });

    await queryInterface.addIndex('payment_records', ['razorpay_payment_id'], {
      name: 'idx_payment_records_razorpay_payment',
    });

    await queryInterface.addIndex('payment_records', ['idempotency_key'], {
      name: 'idx_payment_records_idempotency',
    });
  },

  async down(queryInterface) {
    await queryInterface.dropTable('payment_records');
  },
};
