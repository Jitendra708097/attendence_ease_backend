module.exports = (sequelize, DataTypes) => {
  const PaymentRecord = sequelize.define(
    'PaymentRecord',
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
      },
      org_id: {
        type: DataTypes.UUID,
        allowNull: false,
        references: {
          model: 'organisations',
          key: 'id',
        },
      },
      invoice_id: {
        type: DataTypes.STRING(255),
        allowNull: false,
      },
      razorpay_order_id: {
        type: DataTypes.STRING(255),
        allowNull: false,
      },
      razorpay_payment_id: {
        type: DataTypes.STRING(255),
        allowNull: false,
        unique: true,
        comment: 'Unique Razorpay payment ID - prevents duplicate payments',
      },
      razorpay_signature: {
        type: DataTypes.STRING(255),
        allowNull: false,
      },
      amount_paise: {
        type: DataTypes.INTEGER,
        allowNull: false,
        comment: 'Amount in paise (INR × 100)',
      },
      currency: {
        type: DataTypes.STRING(3),
        defaultValue: 'INR',
        allowNull: false,
      },
      status: {
        type: DataTypes.ENUM('pending', 'verified', 'failed'),
        defaultValue: 'verified',
        allowNull: false,
      },
      error_code: {
        type: DataTypes.STRING(50),
        allowNull: true,
      },
      error_message: {
        type: DataTypes.TEXT,
        allowNull: true,
      },
      idempotency_key: {
        type: DataTypes.STRING(255),
        allowNull: true,
        unique: true,
        comment: 'Idempotency key for retry detection - ensures no duplicate processing',
      },
      created_at: {
        type: DataTypes.DATE,
        defaultValue: DataTypes.NOW,
      },
      updated_at: {
        type: DataTypes.DATE,
        defaultValue: DataTypes.NOW,
      },
    },
    {
      tableName: 'payment_records',
      timestamps: false,
      underscored: true,
      indexes: [
        {
          fields: ['org_id', 'invoice_id'],
          unique: true,
          name: 'idx_payment_records_org_invoice_unique',
        },
        {
          fields: ['org_id', 'created_at'],
          name: 'idx_payment_records_org_created',
        },
        {
          fields: ['razorpay_payment_id'],
          name: 'idx_payment_records_razorpay_payment',
        },
        {
          fields: ['idempotency_key'],
          name: 'idx_payment_records_idempotency',
        },
      ],
    }
  );

  PaymentRecord.associate = (models) => {
    PaymentRecord.belongsTo(models.Organisation, {
      foreignKey: 'org_id',
      onDelete: 'CASCADE',
    });
  };

  return PaymentRecord;
};
